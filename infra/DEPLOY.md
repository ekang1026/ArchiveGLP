# Deploying one firm stack to AWS

One firm = one AWS account. The stack actually splits across two regions:
the primary region holds everything (VPC, Lambdas, API Gateway, Aurora,
Cognito, KMS, primary S3 buckets, SQS, D3P role) and the replica region
holds a KMS key + Object-Lock-enabled S3 buckets that the primary's CRR
rules target.

## Prereqs

- Node 22, pnpm 10 locally.
- An AWS account you're OK parking ~$90/mo on.
- An IAM user or role with `AdministratorAccess` for the initial deploy.
  (Least-privilege can come later; bootstrapping CDK across regions
  needs a lot of IAM permissions.)
- AWS CLI v2 installed and a named profile configured.

```bash
aws configure --profile archiveglp-dev
aws sts get-caller-identity --profile archiveglp-dev
```

## 1. Configure the firm

Create `infra/cdk.context.json` (not checked in; the file is per-deploy).

```json
{
  "firm": "firm_archdev001",
  "firms/firm_archdev001": {
    "firm_id": "firm_archdev001",
    "display_name": "ArchiveGLP Dev",
    "retention_years": 3,
    "legal_hold_default": false,
    "primary_region": "us-east-1",
    "replica_region": "us-west-2",
    "d3p_principal_arn": "arn:aws:iam::111111111111:role/PlaceholderD3P",
    "account_id": "111111111111"
  }
}
```

Replace `111111111111` with your 12-digit AWS account ID. For a dev
deploy with no real D3P yet, set `d3p_principal_arn` to a role in your
own account (e.g. `arn:aws:iam::<you>:role/<any-real-role>`) so the
trust policy validates.

> `retention_years` MUST be >= 3 (schema enforces). Remember that Object
> Lock Compliance means **every object archived will remain immutable for
> this many years**; even deleting the stack won't remove them. For a
> throwaway dev environment, 3 is the floor.

## 2. Bootstrap CDK in both regions

CDK needs a bootstrap stack (assets bucket, IAM roles) in every region
it deploys to. Do this once per (account, region).

```bash
cd infra
npx cdk bootstrap \
  aws://<account_id>/us-east-1 \
  --profile archiveglp-dev
npx cdk bootstrap \
  aws://<account_id>/us-west-2 \
  --profile archiveglp-dev
```

Each takes ~2 min.

## 3. Build Lambda bundles

CDK uses `lambda.Code.fromAsset(apps/api/dist/<fn>)`. If those
directories don't exist (or `CDK_REQUIRE_BUILT_LAMBDAS=1` and they're
stale), synth fails. So always rebuild first.

```bash
pnpm --filter @archiveglp/api build
ls apps/api/dist/
# should show: admin archiver authorizer enroll heartbeat ingest migrate
```

## 4. Synth + diff (dry run)

```bash
cd infra
CDK_REQUIRE_BUILT_LAMBDAS=1 \
  npx cdk synth --all --profile archiveglp-dev -c firm=firm_archdev001
```

Should produce `cdk.out/` with two templates:
`ArchiveGLP-firm_archdev001-Replica.template.json` (replica region) and
`ArchiveGLP-firm_archdev001.template.json` (primary region).

```bash
CDK_REQUIRE_BUILT_LAMBDAS=1 \
  npx cdk diff --all --profile archiveglp-dev -c firm=firm_archdev001
```

Review the diff. On a fresh deploy it'll show ~80 new resources.

## 5. Deploy

The replica stack must land before the primary (primary depends on
replica bucket + KMS ARNs via cross-region references). CDK's
`--all` with `addDependency` handles ordering.

```bash
CDK_REQUIRE_BUILT_LAMBDAS=1 \
  npx cdk deploy --all --profile archiveglp-dev \
  -c firm=firm_archdev001 \
  --require-approval never
```

Expect ~20–30 minutes total on first deploy. Aurora Serverless v2 is the
slow part (8–15 min).

## 6. Grab the outputs

After deploy, CDK prints outputs. Save them.

```
Outputs:
ArchiveGLP-firm_archdev001.AgentApiUrl = https://abcd1234.execute-api.us-east-1.amazonaws.com
ArchiveGLP-firm_archdev001.AdminKeySecretArn = arn:aws:secretsmanager:us-east-1:...:secret:archiveglp/firm_archdev001/admin-key-abc
ArchiveGLP-firm_archdev001.UserPoolId = us-east-1_xxxxx
ArchiveGLP-firm_archdev001.UserPoolClientId = xxxxxxxxxxxx
ArchiveGLP-firm_archdev001.DbEndpoint = archiveglp-xxxx.cluster-...rds.amazonaws.com
ArchiveGLP-firm_archdev001.D3PRoleArn = arn:aws:iam::...:role/ArchiveGLP-firm_archdev001-D3P
```

## 7. Smoke test

Migration custom resource runs automatically during deploy. Confirm
tables exist:

```bash
aws rds-data execute-statement \
  --profile archiveglp-dev \
  --resource-arn <DB cluster ARN from outputs> \
  --secret-arn <DB secret ARN; find in Secrets Manager console> \
  --database archiveglp \
  --sql "SELECT name FROM schema_migrations"
# Should list: 001_init, 002_pending_enrollment
```

Issue a pairing code:

```bash
ADMIN_KEY=$(aws secretsmanager get-secret-value \
  --profile archiveglp-dev \
  --secret-id <AdminKeySecretArn> \
  --query SecretString --output text)

curl -X POST "<AgentApiUrl>/admin/pending-enrollments" \
  -H "X-Admin-Key: $ADMIN_KEY" \
  -H "content-type: application/json" \
  -d '{
    "firm_id": "firm_archdev001",
    "employee_id": "emp_me0000001",
    "employee_email": "me@archiveglp-dev.test",
    "employee_full_name": "Me",
    "expires_in_hours": 24
  }'
# -> {"pairing_code":"...","expires_at":"..."}
```

Enroll the agent against the real API:

```bash
cd apps/agent
export ARCHIVEGLP_FIRM_ID=firm_archdev001
export ARCHIVEGLP_EMPLOYEE_ID=emp_me0000001
export ARCHIVEGLP_DEVICE_ID=dev_me000macmini
export ARCHIVEGLP_API_BASE_URL=<AgentApiUrl>
.venv/bin/archiveglp-agent enroll
# paste the pairing code from the curl response
.venv/bin/archiveglp-agent run
```

Verify archive objects landed with Object Lock set:

```bash
aws s3api list-objects-v2 \
  --profile archiveglp-dev \
  --bucket archiveglp-firm-archdev001-archive-us-east-1 \
  --max-items 5
aws s3api get-object-retention \
  --profile archiveglp-dev \
  --bucket archiveglp-firm-archdev001-archive-us-east-1 \
  --key <first key from list-objects output>
# Should show Mode=COMPLIANCE and RetainUntilDate ~= now + 3y
```

## Teardown

You can `cdk destroy` the primary stack. **Object-Lock-Compliance
buckets refuse to be emptied before retention expires.** CloudFormation
will mark them DELETE_FAILED and leave them behind. Same with the
KMS CMK (scheduled for 30-day deletion) and Aurora (deletion-protected
by design).

Practical recovery path for a dev account you want clean:

```bash
# Stop paying for the expensive bits: Aurora + NAT Gateway
# (You cannot delete them via CDK while dependencies exist. Remove
#  from the stack or manually.)

# Or just close the AWS account - that tears everything down after
# a 90-day waiting period, including the Object-Locked S3 buckets.
```

For production, Object Lock resistance is the feature, not a bug.

## CI

CI runs `pnpm --filter @archiveglp/infra test` which synths without
`CDK_REQUIRE_BUILT_LAMBDAS` set, using inline placeholders. That's fine
for catching shape regressions. CI does not (yet) do a real deploy.

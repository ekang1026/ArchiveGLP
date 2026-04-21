# ArchiveGLP

Electronic communications archiving for SEC-registered investment advisers and FINRA-regulated broker-dealers. Compliant with SEC Rule 17a-4(f) (non-rewriteable, non-erasable storage; serialized, time-stamped; duplicate copy; designated third party access) and FINRA Rule 3110 supervisory review requirements.

> Scope of the MVP: device-resident macOS agent that captures iMessage under the employee's own user session with informed consent, forwarding to an AWS archive with S3 Object Lock (Compliance mode) and per-firm account isolation.

## Layout

```
apps/
  agent/       Python macOS agent (runs as the employee, reads ~/Library/Messages/chat.db)
  api/         AWS Lambda ingestion + admin API (TypeScript)
  dashboard/   Next.js supervisor dashboard (TypeScript, Cognito SAML)
packages/
  schema/      Canonical event schema (Zod). Source of truth; Python types are generated.
infra/         AWS CDK v2 (TypeScript). One stack per firm account.
```

## Development

```
pnpm install
pnpm build
pnpm test
```

## Compliance posture

- **Storage**: S3 Object Lock, Compliance mode, configurable retention (>= 3y floor), CRR to second region.
- **Credentials**: no Apple ID custody. Agent runs as the employee. Device identity via Secure Enclave keypair.
- **Tenancy**: one AWS account per firm under AWS Organizations.
- **D3P**: per-firm read-only IAM role for the designated third party.
- **Audit**: every supervisor action (view, search, export) is itself an archived event.

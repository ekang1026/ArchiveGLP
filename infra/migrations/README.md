# Migrations

Forward-only SQL migrations applied in filename order.

Applied via the RDS Data API by a Lambda-backed CloudFormation custom resource
(TBD) or manually for local/dev:

```
aws rds-data execute-statement \
  --resource-arn $CLUSTER_ARN --secret-arn $SECRET_ARN \
  --database archiveglp \
  --sql "$(cat 001_init.sql)"
```

Rules:
- Additive only. Dropping columns requires a two-step deploy (deprecate, then
  drop in a subsequent release).
- No `DELETE` or `UPDATE` of `message_meta` / `attachment_meta` rows outside
  of legal-hold tooling - those rows mirror WORM storage.
- Every migration wrapped in `BEGIN/COMMIT`.

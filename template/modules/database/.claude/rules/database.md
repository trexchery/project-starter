---
paths:
  - "**/migrations/**"
  - "**/*.sql"
  - "prisma/**"
  - "drizzle/**"
  - "alembic/**"
  - "**/schema.*"
  - "**/models/**"
---
Database code. Change the schema only through a migration that reverses cleanly or documents its rollback. Never
run destructive migrations or bulk deletes against shared data; tests use an isolated database.

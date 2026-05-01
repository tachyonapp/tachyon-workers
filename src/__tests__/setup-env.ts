// Sets default env vars before any module is loaded.
// Values are only applied if the env var is not already set,
// so CI/CD can override them via the environment.
process.env.DATABASE_URL ??=
  "postgres://tachyon:tachyon_local_dev@localhost:5432/tachyon_dev";
process.env.DB_ENCRYPTION_KEY ??= "a".repeat(64);
process.env.ANTHROPIC_API_KEY ??= "test-key";
process.env.POSTGRES_SSL ??= "false";

# tachyon-workers

Background job processing service for the Tachyon platform (BullMQ + ValKey).

## Local Development

### Option A — Infrastructure only (recommended)

Start PostgreSQL and ValKey via Docker, then run workers directly:

```bash
# From tachyon-infra
docker compose up postgres valkey

# From this repo
cp ../tachyon-infra/env/.env.local.example .env.local
export NODE_AUTH_TOKEN=<your-github-pat>  # GitHub PAT with read:packages scope
npm install
npm run dev
```

### Option B — Full stack via Docker Compose

```bash
# From tachyon-infra — NODE_AUTH_TOKEN is required for the Docker build
# to pull @tachyonapp/tachyon-db from GitHub Packages
export NODE_AUTH_TOKEN=<your-github-pat>
docker compose up
```

### Option C — Build Docker image locally

```bash
export NODE_AUTH_TOKEN=<your-github-pat>
docker build --secret id=node_auth_token,env=NODE_AUTH_TOKEN .
```

> `NODE_AUTH_TOKEN` is passed as a BuildKit secret and is never written to any
> image layer. It cannot be extracted via `docker history`.

## Scripts

```bash
npm run dev       # Start with hot reload (tsx watch)
npm run build     # Compile TypeScript
npm test          # Run Jest tests
npm run lint      # Run ESLint
```


## BullMQ

**Queue configuration reference:**

| Queue | Attempts | Backoff type | Base delay |
|---|---|---|---|
| `scan:dispatch` | 3 | exponential | 5,000 ms |
| `scan:bot` | 3 | exponential | 5,000 ms |
| `expiry` | 5 | exponential | 2,000 ms |
| `reconciliation` | 5 | exponential | 10,000 ms |
| `notification` | 4 | exponential | 5,000 ms |
| `summary` | 3 | exponential | 30,000 ms |

**Workers configuration reference:**

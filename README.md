# Distributed Email Sending System

### Description
This is a pnpm monorepo based Distributed Email Sending System utilizing concepts such as producer-consumer based architecture, idempotency and JWT based authentication (access and refresh tokens).

### File Structure
```
    |-- apps
        |-- api
        |-- worker
    |-- packages
        |-- contracts
        |-- database
        |-- queue
    |-- .env.example
    |-- .gitignore
    |-- docker-compose.yml
    |-- package.json
    |-- pnpm-lock.yaml
    |-- pnpm-workspace.yaml
    |-- README.md
    |-- tsconfig.json
```

### Tech Stack
- pnpm package manager
- Node.js
- Express.js
- Docker
- BullMQ
- Redis
- Nodemailer
- Zod (validation library)
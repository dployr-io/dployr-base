# Data Layer

This directory contains the data layer for dployr base, built on PostgreSQL.

## Migrations

The migration system automatically discovers and applies database schema changes.

### Adding Migrations

1. Create a new migration file: `src/lib/db/migrations/001_add_feature.ts`
2. Export the SQL as a constant:
   ```typescript
   export const add_feature = `
   ALTER TABLE users ADD COLUMN avatar_url TEXT;
   CREATE INDEX idx_users_avatar ON users(avatar_url);
   `;
   ```
3. Add export to `index.ts`: `export * from './001_add_feature';`

### Migration Execution

Migrations run automatically on application startup. The system:
- Creates a `_migrations` table to track applied migrations
- Discovers all exported string constants from the migrations module
- Applies migrations in alphabetical order by export name
- Skips already-applied migrations

## Data Stores

The store layer provides type-safe database operations through dedicated classes.

- **UserStore**: User account management
- **ClusterStore**: Cluster/organization management  
- **InstanceStore**: Application instance management
- **KVStore**: Session and temporary data storage

### Usage

```typescript
import { DatabaseStore, KVStore } from '@/lib/db/store';
import { PostgresAdapter } from '@/lib/db/pg-adapter';

const db = new PostgresAdapter(process.env.DATABASE_URL);
const dbStore = new DatabaseStore(db);
const kvStore = new KVStore(env.BASE_KV);

// Create a user
const user = await dbStore.users.create({
  email: 'user@example.com',
  name: 'John Doe',
  provider: 'google'
});

// Create a session
const sessionId = 'session_123';
const session = await kvStore.createSession(sessionId, user, ['cluster1']);

// Validate OAuth state
await kvStore.createState('csrf_token');
const isValid = await kvStore.validateState('csrf_token');
```

## KV Store

The KV store handles temporary and session data using Cloudflare KV storage.

### Operations

**Session Management**
- `createSession(sessionId, user, clusters)`: Create user session with TTL
- `getSession(sessionId)`: Retrieve active session
- `deleteSession(sessionId)`: Remove session

**OAuth Security**
- `createState(state)`: Store CSRF protection token
- `validateState(state)`: Validate and consume state token

**OTP Authentication**
- `createOTP(email)`: Generate 6-character OTP code
- `validateOTP(email, code)`: Verify OTP with attempt limiting

### TTL Configuration

- Sessions: 7 days
- OAuth state: 10 minutes  
- OTP codes: 10 minutes


### TODO: ERD

- Users belong to multiple clusters with specific roles
- Clusters contain multiple instances
- All tables include created_at/updated_at timestamps
- Foreign keys enforce referential integrity

## Development

### Local Development

Use PostgreSQL for local development:

```bash
# Create local database
createdb dployr-local

# Set connection string
export DATABASE_URL="postgresql://localhost/dployr-local"

# Run migrations (migrations run automatically on app startup)
# Or manually connect and run SQL from migrations/000_init.ts

# Query database
psql $DATABASE_URL -c "SELECT * FROM users"
```

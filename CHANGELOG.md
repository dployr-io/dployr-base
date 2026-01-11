## [0.1.47] - 2026-01-11

### 🚜 Refactor

- *(websocket)* Replay only last unacked message instead of all messages
## [0.1.46] - 2026-01-11

### 🚜 Refactor

- *(websocket)* Simplify agent handler and update broadcast signature
- *(websocket)* Remove debug logging and obsolete comment
## [0.1.45] - 2026-01-06

### 🚜 Refactor

- *(agent)* Add support for v1.1 agent update schema
- *(websocket)* Add process history retrieval handler with time-range filtering
- *(kv)* Reduce process snapshot TTL from 24 hours to 2 hours
## [0.1.44] - 2026-01-05

### 🚜 Refactor

- *(websocket)* Add template parameter to proxy add request
## [0.1.43] - 2026-01-03

### 🚜 Refactor

- *(websocket)* Add proxy management operations with status, restart, add, and remove handlers
## [0.1.42] - 2025-12-31

### 🚜 Refactor

- *(auth)* Replace dynamic redirect URL with APP_URL constant in OAuth callback handler
## [0.1.40] - 2025-12-31

### 🚜 Refactor

- *(auth)* Fix redirect URL handling and metadata merge in user upsert
## [0.1.39] - 2025-12-31

### 🚜 Refactor

- *(install)* Replace xargs with sed for whitespace trimming in TOML parser to improve POSIX compatibility
- *(install)* Improve TOML parser to handle sections, comments, and multi-value lines with proper line-by-line processing
- *(config)* Add Microsoft OAuth configuration support with client ID and secret in auth config schema and bootstrap middleware
## [0.1.38] - 2025-12-31

### 🚜 Refactor

- *(proxy)* Add traffic routing API with hostname resolution, cache management, and service discovery endpoints
- *(install)* Add proxy configuration options with CLI flags and config file support for enabling proxy, port, host, base domain, timeout, and cache TTL settings
- *(ci)* Add automated changelog generation workflow with git-cliff configuration
## [0.1.36] - 2025-12-30

### 🚜 Refactor

- *(agent)* Add UpdateProcessor for agent state synchronization with process snapshots and service sync
## [0.1.34] - 2025-12-29

### 🚜 Refactor

- *(runtime)* Add semantic version sorting for dployrd version list
- *(websocket)* Add deployment list handler and improve task error handling with structured error codes
## [0.1.33] - 2025-12-28

### 🚜 Refactor

- *(websocket)* Pass service name to createServiceRemoveTask for service removal operations
- *(websocket)* Replace instanceId with instanceName in system operation handlers for token rotation, install, reboot, and restart
- *(instances)* Add KV cache layer to InstanceStore for improved lookup performance
- *(agent)* Replace instanceId with instanceName in agent authentication
## [0.1.32] - 2025-12-23

### 🚜 Refactor

- *(websocket)* Move unacked message storage before client send loop to ensure message is stored even if send fails
- *(websocket)* Add instance system operation handlers for token rotation, install, reboot, and restart
- *(websocket)* Add file watch handlers for real-time filesystem change notifications
- *(types)* Replace generic IDBAdapter interface with concrete PostgresAdapter type
- *(services)* Add service store with migration, and ws handlers for service deployment, removal
## [0.1.31] - 2025-12-21

### 🚜 Refactor

- *(websocket)* Add log stream message handler for deployment and service logs
- *(domains,config)* Reorganize domain endpoints, add GitHub token support, and improve DNS verification flow
- *(config)* Add cross-env for development mode and use separate dev config file
- *(websocket)* Add file operation handlers, replace log stream mode with duration parameter for time-based log stream filtering
- *(websocket)* Add connection manager with request tracking, timeout handling, and statistics endpoint
## [0.1.30] - 2025-12-16

### 🚜 Refactor

- *(db)* Change timestamp defaults to milliseconds and rename custom_domains table to domains
- *(websocket)* Rename instance connections to cluster connections and standardize TTL parameter
- *(config,websocket)* Add integrations config section, implement deployment WebSocket handler, and improve auth middleware
- *(websocket)* Add user role to session clusters and pass session context through WebSocket connections for deployment authorization
## [0.1.29] - 2025-12-10

### 📚 Documentation

- *(openapi)* Change instance and domain deletion endpoints to return 204 No Content instead of 200 with JSON response
## [0.1.28] - 2025-12-10

### 🚜 Refactor

- *(websocket)* Extract client notification logic into dedicated ClientNotifier class

### 📚 Documentation

- *(openapi)* Add custom domain management endpoints and implement domain verification system
## [0.1.27] - 2025-12-09

### 🚜 Refactor

- *(server)* Extract bootstrap, CORS, WebSocket, and routing logic into dedicated modules
## [0.1.26] - 2025-12-09

### 🚜 Refactor

- *(kv)* Add JSON validation and error handling for event retrieval methods
## [0.1.25] - 2025-12-09

### 🚜 Refactor

- *(config)* Add redis dependency and improve configuration handling for server, email, and CORS settings
- *(db)* Remove JSON string serialization for metadata fields, in favor of native JSONB handling

### 📚 Documentation

- *(openapi)* Add WebSocket task protocol schemas and improve agent communication documentation
- *(openapi)* Add system install/restart endpoints and daemon compatibility check
- *(openapi)* Remove log streaming and instance WebSocket endpoints, refactor instance store query and task types
- *(openapi)* Add daemon restart endpoint, refactor reboot endpoint, and improve version management
## [0.1.24] - 2025-12-07

### 🚜 Refactor

- *(install)* Add dployr-base service startup to installation script
- *(email)* Add from_address configuration and validation for email service
## [0.1.23] - 2025-12-07

### 🚜 Refactor

- *(build)* Add TypeScript type checking to build script
## [0.1.22] - 2025-12-07

### 🚜 Refactor

- *(deps)* Remove fixed @upstash/redis dependency
## [0.1.21] - 2025-12-07

### 🚜 Refactor

- *(version)* Add version tracking to health endpoint and build process
## [0.1.19] - 2025-12-07

### 🚜 Refactor

- *(install)* Add TLS certificate permission configuration for Caddy
- *(config)* Update  setup and improve Node.js server initialization
## [0.1.18] - 2025-12-07

### 🚜 Refactor

- *(config)* Add debug logging for CORS configuration and remove config file existence check
## [0.1.17] - 2025-12-06

### 🚜 Refactor

- *(cors)* Add *.dployr.io as default allowed CORS origin
## [0.1.16] - 2025-12-06

### 🚜 Refactor

- *(install)* Simplify Caddy service restart
- *(cors)* Add wildcard domain pattern support for CORS origins
## [0.1.15] - 2025-12-06

### 🚜 Refactor

- *(install)* Skip Caddyfile update when file already exists
- *(domain)* Update domain references from dployr.dev to dployr.io
- *(config)* Add CORS configuration support and improve type safety
## [0.1.14] - 2025-12-06

### 🚜 Refactor

- *(migrations)* Execute PostgreSQL migrations as single statements instead of splitting by delimiters
## [0.1.13] - 2025-12-06

### 🚀 Features

- *(install)* Add conditional installation of KV store dependencies

### 🚜 Refactor

- *(install)* Switch to tsx execution and add Caddy reverse proxy configuration
- *(config)* Replace Redis URL with explicit connection parameters
## [0.1.12] - 2025-12-05

### 🚀 Features

- *(types)* Add module declarations for optional runtime dependencies
## [0.1.11] - 2025-12-05

### 🚜 Refactor

- *(imports)* Add .js extensions and type annotations for ESM compatibility
## [0.1.10] - 2025-12-05

### 🚜 Refactor

- *(websocket)* Replace Durable Objects with native WebSocket handler
## [0.1.9] - 2025-12-05

### 🚜 Refactor

- *(docker)* Pin pnpm version, add .dockerignore, and update configuration
- *(docker)* Switch from esbuild to tsx for TypeScript execution and update development configuration
- *(logs)* Replace logType enum with flexible path-based log streaming
- *(deployment)* Remove Cloudflare Workers support and switch to PostgreSQL-only deployment
- *(release)* Switch from bundled dist to source files in release tarball

### 📚 Documentation

- *(openapi)* Move domain registration endpoint to new Domains tag
## [0.1.7] - 2025-12-01

### 🚀 Features

- *(docker)* Add better-sqlite3 rebuild step to ensure native bindings compatibility
## [0.1.6] - 2025-12-01

### 🚜 Refactor

- *(ci)* Update Discord notification title
- *(config)* Update default port from 3000 to 7878
## [0.1.2] - 2025-12-01

### 🚀 Features

- *(build)* Add better-sqlite3 to external dependencies in build script
## [0.1.0] - 2025-12-01

### 🚀 Features

- *(routes)* Add GitHub route and update CORS configuration for PATCH requests
- *(dependencies)* Add GitHub and deployment SDK dependencies
- *(dependencies)* Add GitHub and deployment SDK dependencies
- *(auth,users)* Enhance user authentication and profile management
- *(routes,database)* Enhance application routing and database migration
- *(auth,database)* Enhance role-based access control and cluster metadata
- *(error_codes)* Restructure error codes and add event logging system
- *(events)* Add cluster-based event filtering and pagination support
- *(api)* Add OpenAPI specification and migrate to Durable Objects for instance provisioning
- *(api)* Add OpenAPI tags and role annotations to all endpoints
- *(auth,docs)* Update session cookie SameSite policy and enable API credentials in docs
- *(instances)* Change instances listing to list instances by clusterId
- *(instances)* Add conflict detection for instance creation with unique constraint handling
- *(instances)* Add event logging for instance and domain operations, and implement instance deletion endpoint
- *(durable)* Refactor InstanceObject to use WebSocket-based task distribution with handshake protocol and status streaming
- *(notifications)* Add typed event subscriptions and management API
- *(runtime)* Add filtering and sorting capabilities to events endpoint
- *(logs)* Add real-time log streaming over WebSocket with live and historical modes
- *(ci)* Add automated release workflow with GitHub Actions

### 🐛 Bug Fixes

- *(api)* Update instance creation status code and add clusterId query parameter to instance logs endpoint

### 💼 Other

- Update dployr-sdk to v1.3.0, add jose, remove zeptomail, and refactor auth middleware
- Update dployr-sdk to v1.4.0 and implement JWT-based instance bootstrap authentication

### 🚜 Refactor

- *(project)* Restructure database initialization and route imports
- *(database,auth)* Remove bootstrap table and migrate to metadata-based GitHub integration
- *(instances,users,constants)* Optimize database operations and add instance update endpoint
- Remove unused bootstrap workflow template file
- Remove unused dployr-sdk dependency
- *(instances)* Remove deprecated HTTP logs endpoint in favor of WebSocket streaming
- *(license)* Change license from MIT to Apache-2.0 and add copyright headers to all files
- *(docker)* Remove Dockerfile as project no longer requires containerized deployment
- *(logs)* Generate streamId server-side instead of requiring it in client request
- *(logs)* Implement offset-based log streaming and active stream tracking
- *(logs)* Replace KV-based WebSocket rate limiting with in-memory implementation

### 📚 Documentation

- *(api)* Update instance creation and update response status codes to 202
- *(api)* Remove instance update endpoint, simplify instance creation, and add domains and GitHub remotes endpoints. Update dployr from @^1.3.0 to @^1.5.0
- *(api)* Add operationId to all endpoints, set JWKS endpoint security to empty array, and add type object to SuccessResponse data field
- *(api)* Add address field to instance registration endpoint request body
- *(api)* Provide install token on instance creation
- *(api)* Remove status field and add description to token field in instance creation response
- *(api)* Add address field to instance registration endpoint request body as required parameter
- *(api)* Remove address field from instance registration endpoint and make it required during instance creation
- *(api)* Add 409 conflict response to instance creation endpoint and add instance deletion endpoint
- *(api)* Add agent endpoints for instance status reporting and task polling
- *(api)* Add agent token rotation and refresh endpoints
- *(api)* Add ClientCertUpdate schema for certificate updates with PEM, SPKI hash, subject, and expiration fields
- *(api)* Fix agent token rotation endpoint path and add required instanceId parameter
- *(api)* Add bearer auth security scheme and fix YAML formatting issues
- *(api)* Add WebSocket status streaming endpoint and schemas for real-time instance monitoring
- *(api)* Replace SystemStatus schema with AgentUpdateMessage schema for agent status reporting
- *(api)* Update WebSocket status streaming to use AgentUpdateMessage schema
- *(api)* Update PaginatedResponse schema with additional fields
- *(api)* Implement global rate limiting documentation and per-user limits
- *(deployment)* Add Docker support and self-hosting installation options

### 🎨 Styling

- *(api)* Add trailing newline

### ⚙️ Miscellaneous Tasks

- *(config)* Update email service from address to dployr.dev
- *(docs)* Replaced with classic deploy - no build needed

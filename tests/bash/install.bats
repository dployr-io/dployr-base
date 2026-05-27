#!/usr/bin/env bats

source "$BATS_TEST_DIRNAME/../../install.sh"

@test "normalize_toml_array: single IP without brackets" {
  result="$(normalize_toml_array '102.88.54.231')"
  [ "$result" = '["102.88.54.231"]' ]
}

@test "normalize_toml_array: two IPs comma-separated" {
  result="$(normalize_toml_array '102.88.54.231, 1.1.1.1')"
  [ "$result" = '["102.88.54.231", "1.1.1.1"]' ]
}

@test "normalize_toml_array: already a TOML array passes through" {
  result="$(normalize_toml_array '["102.88.54.231", "1.1.1.1"]')"
  [ "$result" = '["102.88.54.231", "1.1.1.1"]' ]
}

@test "normalize_toml_array: strips extra whitespace around IPs" {
  result="$(normalize_toml_array '  102.88.54.231  ,  1.1.1.1  ')"
  [ "$result" = '["102.88.54.231", "1.1.1.1"]' ]
}

@test "normalize_toml_array: strips surrounding quotes from input" {
  result="$(normalize_toml_array '"102.88.54.231"')"
  [ "$result" = '["102.88.54.231"]' ]
}

@test "parse_pg_url: accepts postgres:// scheme" {
  parse_pg_url "postgres://alice:s3cr3t@db.example.com:5432/mydb" h p u pw n
  [ "$h" = "db.example.com" ]
  [ "$p" = "5432" ]
  [ "$u" = "alice" ]
  [ "$pw" = "s3cr3t" ]
  [ "$n" = "mydb" ]
}

@test "parse_pg_url: accepts postgresql:// scheme" {
  parse_pg_url "postgresql://alice:s3cr3t@db.example.com:5432/mydb" h p u pw n
  [ "$h" = "db.example.com" ]
  [ "$p" = "5432" ]
  [ "$u" = "alice" ]
  [ "$pw" = "s3cr3t" ]
  [ "$n" = "mydb" ]
}

@test "parse_pg_url: returns 1 on invalid url" {
  run parse_pg_url "not-a-url" h p u pw n
  [ "$status" -eq 1 ]
}

@test "parse_pg_url: handles DigitalOcean connection string" {
  parse_pg_url "postgres://doadmin:pass@db-do-user-123.d.db.ondigitalocean.com:25061/defaultdb" h p u pw n
  [ "$h" = "db-do-user-123.d.db.ondigitalocean.com" ]
  [ "$p" = "25061" ]
  [ "$u" = "doadmin" ]
  [ "$pw" = "pass" ]
  [ "$n" = "defaultdb" ]
}

@test "parse_pg_url: returns 1 when port is missing" {
  run parse_pg_url "postgres://alice:s3cr3t@db.example.com/mydb" h p u pw n
  [ "$status" -eq 1 ]
}

@test "render_caddyfile: contains domain and reverse proxy port" {
  run render_caddyfile "base.dployr.io" 7878
  [[ "$output" == *"base.dployr.io"* ]]
  [[ "$output" == *"localhost:7878"* ]]
}

@test "render_caddyfile: port 80 returns 403" {
  run render_caddyfile "base.dployr.io" 7878
  [[ "$output" == *":80"* ]]
  [[ "$output" == *"error 403"* ]]
}

@test "render_caddyfile: port 443 blocked with tls" {
  run render_caddyfile "base.dployr.io" 7878
  [[ "$output" == *":443"* ]]
  [[ "$output" == *"tls /etc/caddy/certs/origin.pem /etc/caddy/certs/origin.key"* ]]
}

@test "render_vector_config: contains endpoint and token" {
  run render_vector_config "https://in.logs.betterstack.com" "tok_abc123" false
  [[ "$output" == *"https://in.logs.betterstack.com"* ]]
  [[ "$output" == *"tok_abc123"* ]]
}

@test "render_vector_config: without listmonk excludes listmonk source" {
  run render_vector_config "https://in.logs.betterstack.com" "tok_abc123" false
  [[ "$output" != *"sources.listmonk"* ]]
}

@test "render_vector_config: with listmonk includes listmonk source and input" {
  run render_vector_config "https://in.logs.betterstack.com" "tok_abc123" true
  [[ "$output" == *"sources.listmonk"* ]]
  [[ "$output" == *'"dployr_base", "listmonk"'* ]]
}

@test "render_listmonk_config: contains db connection params" {
  run render_listmonk_config "https://lists.example.com" "db.host.com" "5432" "dbuser" "dbpass" "appdb"
  [[ "$output" == *'host         = "db.host.com"'* ]]
  [[ "$output" == *'port         = 5432'* ]]
  [[ "$output" == *'user         = "dbuser"'* ]]
  [[ "$output" == *'password     = "dbpass"'* ]]
  [[ "$output" == *'database     = "appdb"'* ]]
}

@test "render_listmonk_config: does not contain deprecated admin credentials" {
  run render_listmonk_config "https://lists.example.com" "db.host.com" "5432" "dbuser" "dbpass" "appdb"
  [[ "$output" != *'admin_username'* ]]
  [[ "$output" != *'admin_password'* ]]
}

@test "render_listmonk_config: binds to localhost:9000" {
  run render_listmonk_config "https://lists.example.com" "db.host.com" "5432" "dbuser" "dbpass" "appdb"
  [[ "$output" == *'localhost:9000'* ]]
}

@test "render_listmonk_config: sets public_url" {
  run render_listmonk_config "https://lists.example.com" "db.host.com" "5432" "dbuser" "dbpass" "appdb"
  [[ "$output" == *'public_url = "https://lists.example.com"'* ]]
}

@test "render_listmonk_unit: contains user, working dir, and config path" {
  run render_listmonk_unit "listmonk" "/opt/listmonk" "/etc/listmonk/config.toml"
  [[ "$output" == *"User=listmonk"* ]]
  [[ "$output" == *"WorkingDirectory=/opt/listmonk"* ]]
  [[ "$output" == *"--config /etc/listmonk/config.toml"* ]]
}

@test "render_dployr_unit: contains service user and working dir" {
  run render_dployr_unit "/opt/dployr-base" "/etc/dployr-base" "dployr" "/usr/local/bin/node" "v1.2.3"
  [[ "$output" == *"User=dployr"* ]]
  [[ "$output" == *"WorkingDirectory=/opt/dployr-base"* ]]
}

@test "render_dployr_unit: config path uses config dir" {
  run render_dployr_unit "/opt/dployr-base" "/etc/dployr-base" "dployr" "/usr/local/bin/node" "v1.2.3"
  [[ "$output" == *'CONFIG_PATH=/etc/dployr-base/config.toml'* ]]
}

@test "render_dployr_unit: version env var is set" {
  run render_dployr_unit "/opt/dployr-base" "/etc/dployr-base" "dployr" "/usr/local/bin/node" "v1.2.3"
  [[ "$output" == *'BASE_VERSION=v1.2.3'* ]]
}

@test "render_dployr_unit: ExecStart uses provided node binary and install dir" {
  run render_dployr_unit "/opt/dployr-base" "/etc/dployr-base" "dployr" "/usr/local/bin/node" "v1.2.3"
  [[ "$output" == *"ExecStart=/usr/local/bin/node --import tsx /opt/dployr-base/src/index.ts"* ]]
}

@test "build_smtp_patch: configures zeptomail smtp host" {
  command -v jq >/dev/null 2>&1 || skip "jq not available"
  run build_smtp_patch '{"app.from_email":"old@example.com","smtp":[]}' "https://lists.example.com" "from@example.com" "apikey123" "https://base.example.com"
  [ "$status" -eq 0 ]
  echo "$output" | jq -e '.smtp[0].host == "smtp.zeptomail.com"' >/dev/null
}

@test "build_smtp_patch: sets root url and from address" {
  command -v jq >/dev/null 2>&1 || skip "jq not available"
  run build_smtp_patch '{"app.from_email":"old@example.com","smtp":[]}' "https://lists.example.com" "from@example.com" "apikey123" "https://base.example.com"
  echo "$output" | jq -e '."app.root_url" == "https://lists.example.com"' >/dev/null
  echo "$output" | jq -e '."app.from_email" == "from@example.com"' >/dev/null
}

@test "build_smtp_patch: sets display name format when from_name provided" {
  command -v jq >/dev/null 2>&1 || skip "jq not available"
  run build_smtp_patch '{"app.from_email":"old@example.com","smtp":[]}' "https://lists.example.com" "from@example.com" "apikey123" "https://base.example.com" "Emmanuel from dployr"
  echo "$output" | jq -e '."app.from_email" == "Emmanuel from dployr <from@example.com>"' >/dev/null
}

@test "build_smtp_patch: sets smtp password to provided key" {
  command -v jq >/dev/null 2>&1 || skip "jq not available"
  run build_smtp_patch '{"app.from_email":"old@example.com","smtp":[]}' "https://lists.example.com" "from@example.com" "apikey123" "https://base.example.com"
  echo "$output" | jq -e '.smtp[0].password == "apikey123"' >/dev/null
}

@test "build_smtp_patch: sets logo and favicon url from base_url" {
  command -v jq >/dev/null 2>&1 || skip "jq not available"
  run build_smtp_patch '{"app.from_email":"old@example.com","smtp":[]}' "https://lists.example.com" "from@example.com" "apikey123" "https://base.example.com"
  echo "$output" | jq -e '."app.logo_url" == "https://base.example.com/icon.png"' >/dev/null
  echo "$output" | jq -e '."app.favicon_url" == "https://base.example.com/favicon.ico"' >/dev/null
}

#!/usr/bin/env bats

source "$BATS_TEST_DIRNAME/../../scripts/traefik/install-traefik.sh"

@test "render_traefik_yml: contains tld in domain config" {
  run render_traefik_yml "us-east" "dployr.run" "redis.host" "6379" "" \
    "secret" "false" "traefik" "acme@dployr.io" \
    "/var/log/traefik" "/var/lib/traefik" "/etc/traefik"
  [[ "$output" == *"dployr.run"* ]]
}

@test "render_traefik_yml: contains redis host and port" {
  run render_traefik_yml "us-east" "dployr.run" "redis.host" "6379" "" \
    "secret" "false" "traefik" "acme@dployr.io" \
    "/var/log/traefik" "/var/lib/traefik" "/etc/traefik"
  [[ "$output" == *"redis.host:6379"* ]]
}

@test "render_traefik_yml: contains redis password" {
  run render_traefik_yml "us-east" "dployr.run" "redis.host" "6379" "" \
    "supersecret" "false" "traefik" "acme@dployr.io" \
    "/var/log/traefik" "/var/lib/traefik" "/etc/traefik"
  [[ "$output" == *'"supersecret"'* ]]
}

@test "render_traefik_yml: contains acme email" {
  run render_traefik_yml "us-east" "dployr.run" "redis.host" "6379" "" \
    "secret" "false" "traefik" "acme@dployr.io" \
    "/var/log/traefik" "/var/lib/traefik" "/etc/traefik"
  [[ "$output" == *"acme@dployr.io"* ]]
}

@test "render_traefik_yml: contains log and data dirs" {
  run render_traefik_yml "us-east" "dployr.run" "redis.host" "6379" "" \
    "secret" "false" "traefik" "acme@dployr.io" \
    "/var/log/traefik" "/var/lib/traefik" "/etc/traefik"
  [[ "$output" == *"/var/log/traefik"* ]]
  [[ "$output" == *"/var/lib/traefik"* ]]
}

@test "render_traefik_yml: includes redis username when provided" {
  run render_traefik_yml "us-east" "dployr.run" "redis.host" "6379" "redisuser" \
    "secret" "false" "traefik" "acme@dployr.io" \
    "/var/log/traefik" "/var/lib/traefik" "/etc/traefik"
  [[ "$output" == *'username: "redisuser"'* ]]
}

@test "render_traefik_yml: omits username block when not provided" {
  run render_traefik_yml "us-east" "dployr.run" "redis.host" "6379" "" \
    "secret" "false" "traefik" "acme@dployr.io" \
    "/var/log/traefik" "/var/lib/traefik" "/etc/traefik"
  [[ "$output" != *'username:'* ]]
}

@test "render_traefik_yml: includes tls block when redis_tls is true" {
  run render_traefik_yml "us-east" "dployr.run" "redis.host" "6379" "" \
    "secret" "true" "traefik" "acme@dployr.io" \
    "/var/log/traefik" "/var/lib/traefik" "/etc/traefik"
  [[ "$output" == *"tls: {}"* ]]
}

@test "render_dashboard_yml: contains dashboard domain" {
  run render_dashboard_yml "admin" 'hashed_pass' "traefik-us.dployr.run" "" ""
  [[ "$output" == *"traefik-us.dployr.run"* ]]
}

@test "render_dashboard_yml: contains basicAuth user and hash" {
  run render_dashboard_yml "admin" 'abc123hash' "traefik-us.dployr.run" "" ""
  [[ "$output" == *"admin:abc123hash"* ]]
}

@test "render_dashboard_yml: includes ip middleware when provided" {
  run render_dashboard_yml "admin" 'hash' "traefik-us.dployr.run" \
    "        - dashboard-ip"$'\n' \
    "    dashboard-ip:"$'\n'"      ipAllowList:"$'\n'
  [[ "$output" == *"dashboard-ip"* ]]
}

@test "render_vector_config: contains endpoint" {
  run render_vector_config "https://in.logs.betterstack.com" "tok_abc123"
  [[ "$output" == *"https://in.logs.betterstack.com"* ]]
}

@test "render_vector_config: contains token" {
  run render_vector_config "https://in.logs.betterstack.com" "tok_abc123"
  [[ "$output" == *"tok_abc123"* ]]
}

@test "render_vector_config: sources traefik log files" {
  run render_vector_config "https://in.logs.betterstack.com" "tok_abc123"
  [[ "$output" == *"/var/log/traefik/*.log"* ]]
}

@test "render_traefik_env: outputs CF_DNS_API_TOKEN line" {
  run render_traefik_env "mytoken123"
  [ "$output" = "CF_DNS_API_TOKEN=mytoken123" ]
}

@test "render_traefik_unit: contains service user" {
  run render_traefik_unit "traefik" "/etc/traefik" "/var/lib/traefik" "/var/log/traefik"
  [[ "$output" == *"User=traefik"* ]]
}

@test "render_traefik_unit: contains config dir in EnvironmentFile" {
  run render_traefik_unit "traefik" "/etc/traefik" "/var/lib/traefik" "/var/log/traefik"
  [[ "$output" == *"EnvironmentFile=/etc/traefik/traefik.env"* ]]
}

@test "render_traefik_unit: ExecStart uses config dir" {
  run render_traefik_unit "traefik" "/etc/traefik" "/var/lib/traefik" "/var/log/traefik"
  [[ "$output" == *"ExecStart=/usr/local/bin/traefik --configFile=/etc/traefik/traefik.yml"* ]]
}

@test "render_traefik_unit: ReadWritePaths contains data and log dirs" {
  run render_traefik_unit "traefik" "/etc/traefik" "/var/lib/traefik" "/var/log/traefik"
  [[ "$output" == *"ReadWritePaths=/var/lib/traefik /var/log/traefik"* ]]
}

@test "render_nginx_conf: contains stub address" {
  run render_nginx_conf "127.0.0.1:19503" "/etc/traefik/static"
  [[ "$output" == *"127.0.0.1:19503"* ]]
}

@test "render_nginx_conf: contains html dir" {
  run render_nginx_conf "127.0.0.1:19503" "/etc/traefik/static"
  [[ "$output" == *"/etc/traefik/static"* ]]
}

@test "render_nginx_conf: sets X-Dployr-Loading header" {
  run render_nginx_conf "127.0.0.1:19503" "/etc/traefik/static"
  [[ "$output" == *"X-Dployr-Loading"* ]]
}

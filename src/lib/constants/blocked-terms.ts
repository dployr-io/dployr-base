// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// Substring-matched after normalization. If the normalized input *contains* any
// of these, it's rejected regardless of surrounding characters.
export const BLOCKED_CONTAINS: ReadonlySet<string> = new Set([
  // csam
  "childporn", "childabuse", "pedophile", "pedophilia", "pedo", "jailbait",

  // terrorism
  "terrorist", "terrorism", "jihadist", "alqaeda", "genocide",
  "massacre", "bioweapon", "anthrax", "ricin", "sarin",

  // violence
  "murderer", "assassination", "hitman", "hitlist",
  "torture", "execution", "kidnapping", "warcrime",

  // self-harm
  "suicide", "selfharm",

  // sexual assault
  "rapist", "molester", "incest",

  // explicit sexual
  "pornography", "sexvideo", "sextape", "hentai",

  // racial slurs
  "nigger", "nigga", "kike", "chink", "gook", "spic",
  "wetback", "beaner", "coon", "jigaboo", "zipperhead",
  "towelhead", "sandnigger", "raghead",

  // homophobic / transphobic / ableist
  "faggot", "tranny", "retarded", "spastic",

  // extremism
  "nazism", "1488", "rahowa", "whitepride", "whitepower",

  // hard drugs
  "cocaine", "heroin", "methamphetamine", "fentanyl", "carfentanil",
  "druglord", "silkroad",

  // profanity
  "fuck", "motherfucker", "shit", "bullshit", "asshole",
  "bitch", "bastard", "dick", "cunt", "pussy",
  "wanker", "bollocks", "twat", "arsehole",

  // degrading
  "whore", "skank",
]);

// Exact-matched after normalization. The *entire* normalized input must equal the
// term. "facebookfinder" passes; "facebook" alone does not.
export const BLOCKED_EXACT: ReadonlySet<string> = new Set([
  // major consumer brands — impersonation / phishing risk
  "google", "gmail", "googledrive", "googlepay",
  "facebook", "meta", "instagram", "threads",
  "twitter", "x",
  "tiktok", "snapchat",
  "youtube",
  "whatsapp", "telegram", "signal", "discord",
  "amazon", "aws",
  "microsoft", "azure", "outlook", "onedrive",
  "apple", "icloud", "appleid", "appstore",
  "openai", "chatgpt", "anthropic", "claude",
  "netflix", "spotify",
  "github", "gitlab",
  "slack", "zoom", "notion", "jira",
  "shopify", "stripe",
  "linkedin",
  "reddit",
  "pinterest",
  "uber", "lyft",
  "airbnb",
  "paypal", "venmo", "cashapp", "zelle",
  "coinbase", "binance", "kraken", "metamask", "trustwallet",
  "visa", "mastercard", "amex",
  "chase", "wellsfargo", "bankofamerica", "barclays", "hsbc",

  // infra primitives — any of these alone as a subdomain is an exploit attempt
  "root", "sudo", "superuser",
  "admin", "administrator",
  "sys", "system",
  "api",
  "db", "database",
  "internal", "intranet",
  "localhost", "loopback",
  "staging", "stage",
  "prod", "production",
  "dev", "develop", "development",
  "test",
  "mail", "smtp", "imap", "pop3",
  "ftp", "sftp", "ssh",
  "dns", "dhcp",
  "vpn", "proxy", "gateway",
  "firewall",
  "kernel",
  "daemon",
  "cron",
  "nginx", "apache",
  "mysql", "postgres", "postgresql", "redis", "mongo", "mongodb",
  "docker", "kubernetes", "k8s",
  "jenkins", "ci", "cd",
  "vault", "secrets",
  "ldap", "oauth", "saml",
  "login", "signin", "signup", "register", "auth", "authenticate",
  "password", "passwd", "credentials",
  "secure", "security",
  "verify", "verification",
  "update", "upgrade",
  "support", "helpdesk",
  "billing", "invoice", "payment",
  "account", "accounts",
  "portal", "dashboard",
  "panel",
  "console",
  "monitor", "metrics",
  "backup",
  "cdn",
]);
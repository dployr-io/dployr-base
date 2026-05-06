// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// Substring-matched. If the normalized input *contains* any of these, reject.
export const BLOCKED_CONTAINS: ReadonlySet<string> = new Set([
  // csam
  "childporn", "childabuse", "pedophile", "pedophilia", "pedo", "jailbait",

  // terrorism / mass violence
  "terrorist", "terrorism", "jihadist", "alqaeda", "alqaida", "genocide",
  "massacre", "bioweapon", "anthrax", "ricin", "sarin",
  "bokoharam", "taliban", "hezbollah", "alshabaab", "jabhatalnusra",
  "islamicstate", "isis", "hamas", "lashkaretaiba", "aumshinrikyo",
  "proudboys", "oathkeepers", "atomwaffen", "patriotfront",

  // violence
  "murderer", "assassination", "hitman", "hitlist",
  "torture", "execution", "kidnapping", "warcrime", "lynching",

  // self-harm
  "suicide", "selfharm",

  // sexual assault / exploitation
  "rapist", "molester", "incest", "bestiality", "grooming",

  // explicit sexual
  "pornography", "sexvideo", "sextape", "hentai",

  // racial slurs
  "nigger", "nigga", "kike", "chink", "gook", "spic",
  "wetback", "beaner", "coon", "jigaboo", "zipperhead",
  "towelhead", "sandnigger", "raghead", "golliwog",

  // homophobic / transphobic / ableist
  "faggot", "tranny", "retarded", "spastic",

  // extremism
  "nazism", "rahowa", "whitepride", "whitepower",

  // hard drugs
  "cocaine", "heroin", "methamphetamine", "fentanyl", "carfentanil",
  "druglord", "silkroad",

  // profanity
  "fuck", "motherfucker", "shit", "bullshit", "asshole",
  "bitch", "bastard", "dick", "cock", "cunt", "pussy",
  "wanker", "bollocks", "twat", "arsehole",

  // degrading
  "whore", "skank",

  // crypto scams / wallet drainers / fake investment funnels
  "airdrop", "giveaway", "freemoney", "freecrypto", "freebitcoin",
  "claimairdrop", "airdropclaim", "claimtoken", "tokenclaim",
  "claimreward", "rewardclaim", "claimbonus", "bonusclaim",
  "walletdrainer", "cryptodrainer", "tokendrainer", "nftdrainer",
  "seedphrase", "recoveryphrase", "privatekey", "walletkey",
  "connectwallet", "walletconnect", "walletverify", "walletverification",
  "walletvalidate", "walletvalidation", "walletrectify", "walletsync",
  "dappsync", "dappsynchronizer", "rectification", "defivalidate",
  "guaranteedreturns", "guaranteedprofit", "riskfreeprofit",
  "doubleyourcrypto", "getrichquick", "investmentplatform",
  "liquiditymining", "binarytrading", "pigbutchering", "shazhupan",
  "cryptorecovery", "fundrecovery", "recoveryfunds", "recoveryagent",
  "unlockfunds", "withdrawalfee", "taxunlock",

  // crypto/payment brand impersonation is high-risk on public subdomains
  "coinbase", "binance", "kraken", "metamask", "trustwallet",
  "phantomwallet", "phantom", "walletconnect", "ledger", "trezor",
  "uniswap", "opensea", "tether", "usdt", "usdc",
]);

// Exact-matched. The entire normalized input must equal the term.
// "facebookfinder" passes; "facebook" alone does not.
export const BLOCKED_EXACT: ReadonlySet<string> = new Set([
  // extremist numeric codes
  "1488", "88",

  // hate as standalone intent
  "hate", "racist", "racism", "sexist", "sexism",
  "bigot", "bigotry", "homophobe", "transphobe",
  "slave", "slavery", "lynch",

  // weapons / wmd standalone
  "nuke", "nukes", "napalm", "semtex",
  "ak47", "ar15", "ak74",
  "landmine", "grenade", "claymore",

  // war criminals / genocidal dictators
  "hitler", "himmler", "goebbels", "mengele", "eichmann",
  "mussolini", "stalin", "polpot",
  "idiamin", "pinochet", "milosevic", "mugabe",
  "saddam", "saddamhussein", "gaddafi", "muammargaddafi",
  "kimjongun", "kimjongil", "kimjonuun",
  "mcveigh",

  // terrorists / sex criminals / financial criminals
  "osama", "binladen", "osamabinladen",
  "epstein", "jeffreyepstein",
  "madoff", "berniemadoff",
  "manson", "charlesmanson",

  // terror organizations
  "bokoharam", "taliban", "hezbollah", "hamas",
  "alshabaab", "jabhatalnusra", "islamicstate", "isis",
  "lashkaretaiba", "aumshinrikyo",
  "proudboys", "oathkeepers", "atomwaffen", "patriotfront",

  // geopolitical
  "northkorea", "dprk", "russia",

  // celebrities / high-profile personalities (impersonation/fraud prevention)
  // music
  "justinbieber", "taylorswift", "theweeknd", "arianagrande", "billyeillish",
  "drake", "eminem", "rihanna", "beyonce", "brucespringsteen",
  "phillipcollins", "themoonoonglezers", "lizzo", "baddo", "topdop",

  // sports
  "cristiano", "cristianoronaldo", "lmessi", "neymarsantos", "haland",
  "therock", "dylanwadeii", "lebronjames", "tomandy", "strivephen",

  // film/tv
  "tomhanks", "merylstreep", "leonardodicaprio", "emmawatson", "tomcruise",
  "angelinajolie", "bradpitt", "johnnydepp", "scarletjohansson",

  // business/tech founders
  "elonmusk", "billgates", "stevejobs", "markzuckerberg", "jeffbezos",
  "sundarpichar", "timcook", "sherylsandberg",

  // royalty
  "kingcharles", "princewilliam", "queenelizabeth",

  // influencers/social media
  "kimkardashian", "kyliejenner", "therock", "oprah", "joerogan",
  "daviddobrik", "jimmifallon", "teddysmith", "mrbeast",

  // big tech — US
  "google", "gmail", "googledrive", "googlepay", "googlecloud",
  "facebook", "meta", "instagram", "threads",
  "twitter", "x",
  "tiktok", "snapchat",
  "youtube",
  "whatsapp", "telegram", "signal", "discord",
  "amazon", "aws",
  "microsoft", "azure", "outlook", "onedrive", "xbox",
  "apple", "icloud", "appleid", "appstore", "iphone", "ipad", "imessage",
  "openai", "chatgpt", "anthropic", "claude",
  "netflix", "spotify", "hulu", "twitch", "primevideo", "disneyplus",
  "github", "gitlab",
  "slack", "zoom", "notion", "jira", "confluence", "atlassian",
  "shopify", "stripe", "square",
  "linkedin", "reddit", "pinterest", "tumblr",
  "uber", "lyft",
  "airbnb",
  "dropbox",
  "salesforce", "hubspot",
  "adobe", "acrobat",
  "oracle", "ibm", "sap",
  "intel", "amd", "nvidia", "qualcomm", "broadcom",
  "cisco", "vmware", "dell", "hp", "hpe", "lenovo",
  "cloudflare", "digitalocean", "heroku", "vercel", "netlify",
  "sendgrid", "twilio", "mailchimp",
  "wordpress", "wix", "squarespace", "webflow",
  "godaddy", "namecheap",
  "ebay", "etsy",
  "doordash", "ubereats", "grubhub",
  "tinder", "bumble", "hinge", "grindr",
  "robinhood", "etrade",
  "quickbooks", "intuit", "turbotax",
  "palantir", "crowdstrike", "splunk", "fortinet",
  "snowflake", "databricks",

  // big tech — Asia
  "alibaba", "aliexpress", "taobao", "tmall", "alipay",
  "tencent", "wechat", "weibo", "baidu",
  "bytedance",
  "xiaomi", "huawei",
  "samsung", "sony", "lg",

  // finance / banking
  "paypal", "venmo", "cashapp", "zelle",
  "coinbase", "binance", "kraken", "metamask", "trustwallet",
  "visa", "mastercard", "amex",
  "chase", "wellsfargo", "bankofamerica", "barclays", "hsbc",
  "citibank", "jpmorgan", "goldmansachs", "morganstanley",
  "deutschebank", "ubs", "tdbank", "usbank",
  "fidelity", "schwab", "vanguard", "blackrock",
  "bitcoin", "ethereum", "binanceusd",

  // telecoms
  "att", "atandt", "verizon", "tmobile", "vodacom",
  "vodafone", "orange", "bt", "mtn", "etisalat", "9mobile", 

  // media / entertainment
  "disney", "hbo", "espn",

  // retail
  "walmart", "target", "costco", "ikea",
  "nike", "adidas",
  "mcdonalds", "starbucks", "kfc",

  // infra primitives
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

// Fuzzy-matched with a conservative edit-distance and confusable-character model.
// Keep this to terms where false negatives are materially worse than false positives.
export const BLOCKED_FUZZY: ReadonlySet<string> = new Set([
  // high-risk safety terms
  "childporn", "childabuse", "pedophile", "pedophilia", "jailbait",
  "terrorist", "terrorism", "jihadist", "alqaeda", "alqaida", "genocide",
  "massacre", "bioweapon", "anthrax", "ricin", "sarin",
  "bokoharam", "taliban", "hezbollah", "hamas", "alshabaab",
  "jabhatalnusra", "islamicstate", "isis", "lashkaretaiba",
  "aumshinrikyo", "proudboys", "oathkeepers", "atomwaffen", "patriotfront",

  // crypto scam terms
  "airdrop", "giveaway", "claimairdrop", "airdropclaim", "claimtoken",
  "claimreward", "walletdrainer", "cryptodrainer", "tokendrainer",
  "seedphrase", "recoveryphrase", "privatekey", "walletconnect",
  "connectwallet", "walletverify", "walletrectify", "dappsync",
  "dappsynchronizer", "guaranteedreturns", "guaranteedprofit",
  "doubleyourcrypto", "getrichquick", "investmentplatform",
  "liquiditymining", "binarytrading", "pigbutchering",
  "cryptorecovery", "fundrecovery", "recoveryfunds", "recoveryagent",

  // high-risk standalone terms from exact matching
  "1488", "88",
  "hate", "racist", "racism", "bigot", "bigotry", "homophobe", "transphobe",
  "slave", "slavery", "lynch",
  "nuke", "nukes", "napalm", "semtex", "ak47", "ar15", "ak74",
  "landmine",
  "hitler", "himmler", "goebbels", "mengele", "eichmann",
  "mussolini", "stalin", "polpot", "idiamin", "pinochet", "milosevic",
  "saddam", "saddamhussein", "gaddafi", "muammargaddafi",
  "kimjongun", "kimjongil", "mcveigh",
  "osama", "binladen", "osamabinladen",
  "epstein", "jeffreyepstein", "madoff", "berniemadoff",
]);

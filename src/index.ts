// src/index.ts
import { Hono } from "hono";
import { cors } from "hono/cors";
import { Bindings, Variables } from "@/types";
import auth from "@/routes/auth";
import { authMiddleware } from "@/middleware/auth";
import { z } from "zod";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const dnsSchema = z.object({
  subdomain: z.string().min(1),
  host: z
    .string()
    .refine(
      (ip) =>
        /^(\d{1,3}\.){3}\d{1,3}$/.test(ip) &&
        ip.split(".").every((n) => Number(n) <= 255),
      {
        message: "Invalid IPv4 address",
      }
    ),
});

app.use("/api/*", cors());

app.route("/api/auth", auth);

app.post("/api/send-email", authMiddleware, async (c) => {
  try {
    const { to, subject, body, name } = await c.req.json();

    if (!to || !subject || !body) {
      return c.json({ error: "Missing required fields" }, 400);
    }

    const emailPayload = {
      to: [
        {
          email_address: {
            address: to,
            name: name || to,
          },
        },
      ],
      from: {
        address: "noreply@zeipo.ai",
      },
      subject,
      htmlbody: body,
    };

    const response = await fetch("https://api.zeptomail.com/v1.1/email", {
      method: "POST",
      headers: {
        Authorization: `Zoho-enczapikey ${c.env.ZEPTO_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(emailPayload),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error("Zepto API error:", error);
      return c.json({ error: "Failed to send email" }, 500);
    }

    return c.json({ message: "Email sent successfully", success: true });
  } catch (error) {
    console.error("Email error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.post("/api/dns/create", authMiddleware, async (c) => {
  try {
    const body = await c.req.json();

    const result = dnsSchema.safeParse(body);
    if (!result.success) {
      return c.json({ error: result.error.issues[0].message }, 400);
    }

    const { subdomain, host } = result.data;
    const fullDomain = `${subdomain}.${c.env.DPLOYR_BASE_URL}`;

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/zones/${c.env.CLOUDFLARE_ZONE_ID}/dns_records`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${c.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          type: "A",
          name: fullDomain,
          content: host,
          ttl: 1,
          proxied: false,
        }),
      }
    );

    if (!response.ok) {
      const error = await response.text();
      console.error("Cloudflare DNS error:", error);
      return c.json({ error: "Failed to update DNS record" }, 500);
    }

    return c.json(
      { message: "DNS record updated successfully", success: true },
      201
    );
  } catch (error) {
    console.error("DNS error:", error);
    return c.json({ error: "Internal server error" }, 500);
  }
});

app.get("/api/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;

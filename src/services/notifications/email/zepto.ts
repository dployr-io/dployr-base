// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Bindings } from "@/types/index.js";
import { EmailPayload, EmailProvider } from "./index.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("ZeptoProvider");

export class ZeptoProvider implements EmailProvider {
  private fromAddress: string;

  constructor(private env: Bindings) {
    this.fromAddress = env.EMAIL_FROM || "";
  }

  async sendEmail({ name, to, subject, body }: EmailPayload): Promise<{ success: boolean; error?: string }> {
    if (!this.fromAddress) {
      log.error("EMAIL_FROM is not configured");
      return { success: false, error: "EMAIL_FROM is not configured" };
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
        address: this.fromAddress,
      },
      subject,
      htmlbody: body,
    };

    const response = await fetch("https://api.zeptomail.com/v1.1/email", {
      method: "POST",
      headers: {
        Authorization: `Zoho-enczapikey ${this.env.ZEPTO_API_KEY}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify(emailPayload),
    });

    if (!response.ok) {
      const error = await response.text();
      log.error("Zepto API error:", { error });
      return { success: false, error: "Failed to send email" };
    }

    return { success: true };
  }
}

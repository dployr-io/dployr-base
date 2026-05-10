// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings } from "@/types/index.js";
import type { EmailTemplate } from "@/lib/templates/emails/index.js";

export interface EmailPayload {
  name?: string | null;
  to: string;
  subject: string;
  body: string;
}

export interface EmailProvider {
  sendEmail({ name, to, subject, body }: EmailPayload): Promise<{ success: boolean; error?: string }>;
}

export class EmailService {
  constructor(
    private provider: EmailProvider,
    private env: Bindings,
  ) {}

  async send<T>(to: string, template: EmailTemplate<T>, data: T): Promise<void> {
    if (process.env.NODE_ENV === "test") return;
    const { subject, html } = template(data);
    await this.provider.sendEmail({ to, subject, body: html });
  }
}

export { ZeptoProvider } from "./zepto.js";

import { Bindings } from "@/types"

export class EmailService {
    private env: Bindings;
    private name?: string;
    private to: string;

    constructor({ env, name, to }: { env: Bindings; name?: string; to: string }) {
        this.env = env;
        this.name = name;
        this.to = to;
    }

    async sendEmail(subject: string, body: string): Promise<{ success: boolean; error?: string }> {
        const emailPayload = {
            to: [{
                email_address: {
                    address: this.to,
                    name: this.name || this.to
                }
            }],
            from: {
                address: 'noreply@zeipo.ai'
            },
            subject,
            htmlbody: body
        };

        const response = await fetch('https://api.zeptomail.com/v1.1/email', {
            method: 'POST',
            headers: {
                'Authorization': `Zoho-enczapikey ${this.env.ZEPTO_API_KEY}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            },
            body: JSON.stringify(emailPayload)
        });

        if (!response.ok) {
            const error = await response.text();
            console.error('Zepto API error:', error);
            return { success: false, error: 'Failed to send email' };
        }

        return { success: true };
    }
}

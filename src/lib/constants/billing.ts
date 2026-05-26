import { SubscriptionPlan } from "@/types/index.js";

export const PLANS = [
  {
    id: "hobby" as SubscriptionPlan,
    name: "Hobby",
    description: "Perfect for getting started and deploying small apps on Dployr",
    price: { monthly: 0, annual: 0 },
    currency: "USD",
    interval: null,
  },
  {
    id: "indie" as SubscriptionPlan,
    name: "Indie",
    description: "For hobbyist developers building side projects",
    price: { monthly: 15, annual: 12 },
    currency: "USD",
    interval: "month",
  },
  {
    id: "pro" as SubscriptionPlan,
    name: "Pro",
    description: "For professional developers and teams shipping production applications",
    price: { monthly: 25, annual: 20 },
    currency: "USD",
    interval: "month",
  },
] as const;

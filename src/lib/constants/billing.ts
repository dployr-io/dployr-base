import { SubscriptionPlan } from "@/types/index.js";

export const PLANS = [
  {
    id: "hobby" as SubscriptionPlan,
    name: "Hobby",
    description: "Perfect for getting started and deploying small apps on Dployr",
    price: 0,
    currency: "USD",
    interval: null,
  },
  {
    id: "indie" as SubscriptionPlan,
    name: "Indie",
    description: "For hobbyist developers building side projects",
    price: 5,
    currency: "USD",
    interval: "month",
  },
  {
    id: "pro" as SubscriptionPlan,
    name: "Pro",
    description: "For professional developers and teams shipping production applications",
    price: 20,
    currency: "USD",
    interval: "month",
  },
] as const;

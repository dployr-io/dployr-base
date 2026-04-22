import { SubscriptionPlan } from "@/types/index.js";

export const PLANS = [
  {
    id: "hobby" as SubscriptionPlan,
    name: "Hobby",
    description: "Perfect for getting started and deploying small apps on Dployr",
    price: 0,
    currency: "USD",
    interval: null,
    checkoutUrl: null,
  },
  {
    id: "indie" as SubscriptionPlan,
    name: "Indie",
    description: "For hobbyist developers building side projects",
    price: 5,
    currency: "USD",
    interval: "month",
    checkoutUrl: "https://buy.polar.sh/polar_cl_9Gikkc1tuZuZn6u4Z39DBjalo9BFc87Nrvk5816rfHV",
  },
  {
    id: "pro" as SubscriptionPlan,
    name: "Pro",
    description: "For professional developers and teams shipping production applications",
    price: 20,
    currency: "USD",
    interval: "month",
    checkoutUrl: "https://buy.polar.sh/polar_cl_kYgoJUbPggOug8KUA3yDT8cEWbfee4MP153bU2VAcu9",
  },
] as const;

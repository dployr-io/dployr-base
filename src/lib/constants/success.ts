export const SUCCESS = {
  OK: { code: "success.ok", status: 200 as const },
  CREATED: { code: "success.created", status: 201 as const },
  ACCEPTED: { code: "success.accepted", status: 202 as const },
  NO_CONTENT: { code: "success.no_content", status: 204 as const },
} as const;

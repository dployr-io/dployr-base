// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import {
  Bindings,
  Variables,
  createErrorResponse,
  createSuccessResponse,
} from "@/types/index.js";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import z from "zod";
import { InstanceService } from "@/services/instances.js";
import { getKV, type AppVariables } from "@/lib/context.js";

const domains = new Hono<{
  Bindings: Bindings;
  Variables: Variables & AppVariables;
}>();

const registerInstanceSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

domains.post("/", async (c) => {
  try {
    const body = await c.req.json();
    const validation = registerInstanceSchema.safeParse(body);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(
        createErrorResponse({
          message: "Validation failed " + JSON.stringify(errors),
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status
      );
    }

    const { token } = validation.data;

    const service = new InstanceService(c.env);
    const result = await service.registerInstance({ token, c });

    if (!result.ok) {
      if (result.reason === "invalid_token") {
        return c.json(
          createErrorResponse({
            message: "Invalid or expired token",
            code: ERROR.AUTH.BAD_TOKEN.code,
          }),
          ERROR.AUTH.BAD_TOKEN.status
        );
      }

      if (result.reason === "invalid_type") {
        return c.json(
          createErrorResponse({
            message: "Invalid token type",
            code: ERROR.AUTH.BAD_TOKEN.code,
          }),
          ERROR.AUTH.BAD_TOKEN.status
        );
      }

      return c.json(
        createErrorResponse({
          message: "Token already used",
          code: ERROR.AUTH.BAD_TOKEN.code,
        }),
        ERROR.AUTH.BAD_TOKEN.status
      );
    }

    const domain = await service.saveDomain({
      instanceId: result.instanceId,
      c,
    });

    const kv = new KVStore(getKV(c));
    await kv.logEvent({
      actor: {
        id: result.instanceId,
        type: "headless",
      },
      targets: [
        {
          id: domain,
        },
      ],
      type: EVENTS.RESOURCE.RESOURCE_CREATED.code,
      request: c.req.raw,
    });

    return c.json(
      createSuccessResponse({
        instanceId: result.instanceId,
        domain,
        issuer: c.env.BASE_URL,
        audience: "dployr-instance",
      })
    );
  } catch (error) {
    console.error("Failed to register instance", error);
    return c.json(
      createErrorResponse({
        message: "Instance registration failed",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status
    );
  }
});

export default domains;

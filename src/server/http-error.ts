import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { PersistenceError } from "@/infrastructure/persistence/game-repository";

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function jsonError(error: unknown) {
  if (error instanceof HttpError) {
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status: error.status },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      {
        error: {
          code: "invalid_request",
          message: "请求参数不完整或格式不正确。",
          issues: error.issues,
        },
      },
      { status: 400 },
    );
  }
  if (error instanceof PersistenceError) {
    const status =
      error.code === "not_found"
        ? 404
        : error.code === "forbidden"
          ? 403
          : error.code === "revision_conflict" || error.code === "command_running"
            ? 409
            : 422;
    return NextResponse.json(
      { error: { code: error.code, message: error.message } },
      { status },
    );
  }

  console.error(error);
  return NextResponse.json(
    { error: { code: "internal_error", message: "服务器暂时无法完成该操作。" } },
    { status: 500 },
  );
}

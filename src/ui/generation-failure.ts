export interface GenerationFailureJob {
  id: string;
  attempts: number;
  maxAttempts: number;
  error: string | null;
}

const genericFailureMessage =
  "这起案件暂时未能完成生成。";

export function generationFailureMessage(job: GenerationFailureJob) {
  const jobContext = `任务 ID：${job.id}；尝试：${job.attempts}/${job.maxAttempts}。`;
  const detail = job.error?.trim();

  if (detail) {
    return `${genericFailureMessage}${jobContext}原始错误：${detail}`;
  }

  return `${genericFailureMessage}${jobContext}Worker 未记录原始错误，请查看 worker 终端日志。`;
}

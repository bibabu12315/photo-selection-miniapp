/**
 * 云函数调用统一入口
 *
 * 架构约定：页面 → service → cloud function → database
 * 页面不允许直接操作数据库。
 */

export interface CloudResponse<T> {
  ok: boolean
  data?: T
  error?: string
}

/**
 * 调用云函数并解包统一返回结构
 * @param name 云函数名
 * @param payload 入参
 */
export async function call<T = any>(name: string, payload: Record<string, any> = {}): Promise<T> {
  const res: any = await (wx as any).cloud.callFunction({ name, data: payload })
  const body: CloudResponse<T> = res && res.result

  if (!body) {
    throw new Error(`云函数 ${name} 没有返回内容，请确认已部署`)
  }
  if (!body.ok) {
    throw new Error(body.error || `云函数 ${name} 执行失败`)
  }
  return body.data as T
}

/** 调用云函数但不抛异常，返回统一结构，便于页面自行展示错误 */
export async function callSafe<T = any>(
  name: string,
  payload: Record<string, any> = {}
): Promise<CloudResponse<T>> {
  try {
    const data = await call<T>(name, payload)
    return { ok: true, data }
  } catch (err: any) {
    return { ok: false, error: err && err.message ? err.message : String(err) }
  }
}

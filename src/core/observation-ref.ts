// 模型侧的观测短引用由不可变事件序号派生，压缩和重启不重新编号。数据库仍存完整记录 id。

export function observationRef(seq: number): string {
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error('观测序号必须是正安全整数');
  return `o${seq}`;
}

export function observationSeq(ref: string): number | undefined {
  if (!/^o[1-9][0-9]{0,15}$/.test(ref)) return undefined;
  const seq = Number(ref.slice(1));
  return Number.isSafeInteger(seq) ? seq : undefined;
}

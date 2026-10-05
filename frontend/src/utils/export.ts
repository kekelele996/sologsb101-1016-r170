/**
 * 导出工具：整库 JSON 存档、晒程进度 CSV、文本复制
 * 全部在浏览器本地完成，不经过任何服务端。
 */
import type { DatabaseSnapshot } from './db';
import { DB_NAME, DB_SCHEMA_VERSION } from './db';
import type { Pond } from '../types/pond';
import type { Observation } from '../types/observation';
import type { Assay } from '../types/assay';
import type { Schedule } from '../types/schedule';
import type { CleaningOrder } from '../types/cleaning';
import { effectiveVerdict, pondVolumeM3, round1 } from './brine';
import { stampSuffix } from './id';

/** 触发浏览器下载 */
export function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

/** CSV 单元格转义 */
export function csvCell(value: string | number): string {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 导出整库 JSON 存档，返回文件名 */
export function exportSnapshotJson(snapshot: DatabaseSnapshot): string {
  const filename = `${DB_NAME}-backup-${stampSuffix()}.json`;
  download(filename, JSON.stringify(snapshot, null, 2), 'application/json;charset=utf-8');
  return filename;
}

export interface SnapshotParseResult {
  ok: boolean;
  message: string;
  snapshot: DatabaseSnapshot | null;
}

/** 解析并校验导入的 JSON 存档 */
export function parseSnapshot(text: string): SnapshotParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, message: 'JSON 解析失败，请确认文件内容完整。', snapshot: null };
  }
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, message: '存档格式不正确：顶层必须是对象。', snapshot: null };
  }
  const data = raw as Partial<DatabaseSnapshot>;
  if (data.name !== DB_NAME) {
    return { ok: false, message: `存档不属于本项目：期望 name = ${DB_NAME}，实际为 ${String(data.name)}。`, snapshot: null };
  }
  if (typeof data.schemaVersion !== 'number' || data.schemaVersion > DB_SCHEMA_VERSION) {
    return {
      ok: false,
      message: `存档数据结构版本不兼容：当前支持 ≤ v${DB_SCHEMA_VERSION}，实际为 v${String(data.schemaVersion)}。`,
      snapshot: null,
    };
  }
  const keys: Array<keyof DatabaseSnapshot> = ['ponds', 'gates', 'observations', 'assays', 'schedules'];
  for (const key of keys) {
    if (!Array.isArray(data[key])) {
      return { ok: false, message: `存档缺少 ${String(key)} 数组。`, snapshot: null };
    }
  }
  // 清池单为 v3 新增：旧版（v1/v2）存档没有该数组，导入侧会按空数组兜底
  const snapshot = data as DatabaseSnapshot;
  if (!Array.isArray(snapshot.cleaningOrders)) snapshot.cleaningOrders = [];
  return { ok: true, message: '存档校验通过。', snapshot };
}

/** 生成晒程进度汇总 CSV */
export function buildProgressCsv(
  ponds: Pond[],
  observations: Observation[],
  assays: Assay[],
  schedules: Schedule[],
  cleaningOrders: CleaningOrder[] = [],
): string {
  const header = [
    '池号',
    '池系',
    '阶段',
    '状态',
    '面积(㎡)',
    '有效水深(cm)',
    '有效体积(m³)',
    '观测条数',
    '最近观测日期',
    '最近密度(g/cm³)',
    '最近蒸发量(mm/d)',
    '化验条数',
    '最近判定',
    '走水计划数',
    '已完成出卤数',
    '清池中计划挪入/排队',
    '清池窗口',
  ];
  const lines: string[] = [header.map(csvCell).join(',')];
  ponds.forEach((pond) => {
    const pondObs = observations.filter((row) => row.pondId === pond.id).sort((a, b) => a.date.localeCompare(b.date));
    const latestObs = pondObs.length > 0 ? pondObs[pondObs.length - 1] : null;
    const pondAssays = assays.filter((row) => row.pondId === pond.id).sort((a, b) => a.date.localeCompare(b.date));
    const latestAssay = pondAssays.length > 0 ? pondAssays[pondAssays.length - 1] : null;
    const pondSchedules = schedules.filter((row) => row.pondId === pond.id);
    const activeOrder = cleaningOrders.find((order) => order.pondId === pond.id && order.state === '清池中');
    const orderSchedules =
      activeOrder === undefined ? [] : schedules.filter((row) => row.cleaningOrderId === activeOrder.id);
    const movedCount = orderSchedules.filter((row) => row.queued !== true && row.pondId !== pond.id).length;
    const queuedCount = orderSchedules.filter((row) => row.queued === true).length;
    const cleaningWindow =
      activeOrder === undefined
        ? '—'
        : `${activeOrder.enterDate}~${activeOrder.exitDate === '' ? '未定' : activeOrder.exitDate}`;
    lines.push(
      [
        pond.code,
        pond.seriesName,
        pond.stage,
        pond.status,
        pond.areaM2,
        pond.depthCm,
        pondVolumeM3(pond.areaM2, pond.depthCm),
        pondObs.length,
        latestObs === null ? '—' : latestObs.date,
        latestObs === null ? 0 : latestObs.densityGcm3,
        latestObs === null ? 0 : latestObs.evapMm,
        pondAssays.length,
        latestAssay === null ? '—' : effectiveVerdict(latestAssay),
        pondSchedules.length,
        pondSchedules.filter((row) => row.state === '已出卤').length,
        activeOrder === undefined ? '—' : `挪${movedCount}/排${queuedCount}`,
        cleaningWindow,
      ]
        .map(csvCell)
        .join(','),
    );
  });
  return `\uFEFF${lines.join('\n')}`;
}

/** 导出晒程进度 CSV 文件 */
export function exportProgressCsvFile(
  ponds: Pond[],
  observations: Observation[],
  assays: Assay[],
  schedules: Schedule[],
  cleaningOrders: CleaningOrder[] = [],
): string {
  const filename = `盐湖晒程进度汇总-${stampSuffix()}.csv`;
  download(filename, buildProgressCsv(ponds, observations, assays, schedules, cleaningOrders), 'text/csv;charset=utf-8');
  return filename;
}

/** 复制文本到剪贴板 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

/** 生成晒程调度通报纯文本 */
export function buildBriefingText(
  ponds: Pond[],
  observations: Observation[],
  assays: Assay[],
  schedules: Schedule[],
  cleaningOrders: CleaningOrder[] = [],
): string {
  const lines: string[] = [`【盐湖晒程调度通报】共 ${ponds.length} 口蒸发池`];
  ponds.forEach((pond) => {
    const pondObs = observations.filter((row) => row.pondId === pond.id).sort((a, b) => a.date.localeCompare(b.date));
    const latest = pondObs.length > 0 ? pondObs[pondObs.length - 1] : null;
    const pondAssays = assays.filter((row) => row.pondId === pond.id).sort((a, b) => a.date.localeCompare(b.date));
    const lastAssay = pondAssays.length > 0 ? pondAssays[pondAssays.length - 1] : null;
    const pending = schedules.filter((row) => row.pondId === pond.id && row.state !== '已出卤').length;
    const order = cleaningOrders.find((o) => o.pondId === pond.id && o.state === '清池中');
    const queued = schedules.filter((row) => row.cleaningOrderId === order?.id && row.queued === true);
    const short = Math.round(queued.reduce((acc, row) => acc + (row.shortM3 ?? 0), 0) * 10) / 10;
    const cleaningText =
      order === undefined
        ? ''
        : `，清池中（${order.enterDate}~${order.exitDate === '' ? '未定' : order.exitDate}）` +
          (queued.length > 0 ? `，走水排队 ${queued.length} 条缺 ${short} m³` : '');
    lines.push(
      `· ${pond.code}（${pond.seriesName} / ${pond.stage} / ${pond.status}）最近密度 ${
        latest === null ? '无观测' : `${latest.densityGcm3} g/cm³（${latest.date}）`
      }，蒸发量 ${latest === null ? '—' : `${round1(latest.evapMm)} mm/d`}，组分判定 ${
        lastAssay === null ? '未化验' : effectiveVerdict(lastAssay)
      }，待完成走水 ${pending} 条${cleaningText}`,
    );
  });
  return lines.join('\n');
}

import { describe, expect, it } from 'vitest';
import { parseCsv } from '../../src/import/csv.js';
import { parseTimetableFile, selectParser } from '../../src/import/registry.js';
import { buildXlsx } from '../helpers/zip-builder.js';

describe('CSV 解析', () => {
  it('基本表格', () => {
    const r = parseCsv('教师,班级,科目,星期,节次\n甲,一班,语文,周一,1\n乙,二班,数学,周二,2\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.headers).toEqual(['教师', '班级', '科目', '星期', '节次']);
    expect(r.table.rows).toHaveLength(2);
    expect(r.table.rows[1]).toEqual(['乙', '二班', '数学', '周二', '2']);
  });

  it('引号内含逗号与转义双引号', () => {
    const r = parseCsv('a,b\n"x,y","他说""好"""\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.rows[0]).toEqual(['x,y', '他说"好"']);
  });

  it('兼容 CRLF 与 UTF-8 BOM', () => {
    const r = parseCsv('\uFEFFa,b\r\n1,2\r\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.headers).toEqual(['a', 'b']);
    expect(r.table.rows[0]).toEqual(['1', '2']);
  });

  it('列数与表头不一致直接报错，不补齐', () => {
    const r = parseCsv('a,b,c\n1,2\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('MALFORMED');
    expect(r.message).toContain('第 2 行');
  });

  it('引号未闭合报错', () => {
    const r = parseCsv('a,b\n"1,2\n');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('MALFORMED');
  });

  it('空文件与只有表头', () => {
    expect(parseCsv('').ok).toBe(false);
    const onlyHeader = parseCsv('a,b\n');
    expect(onlyHeader.ok).toBe(false);
    if (onlyHeader.ok) return;
    expect(onlyHeader.code).toBe('EMPTY_FILE');
  });

  it('忽略空行', () => {
    const r = parseCsv('a,b\n1,2\n\n3,4\n');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.rows).toHaveLength(2);
  });
});

describe('XLSX 解析', () => {
  const rows = [
    ['教师', '班级', '科目', '星期', '节次'],
    ['示例教师甲', '虚构一年一班', '语文', '周一', 1],
    ['示例教师乙', '虚构一年二班', '数学', '周二', 2],
    ['示例教师甲', '虚构一年一班', '语文', '周三', 3],
  ];

  it('读取共享字符串、内联字符串与数字单元格（stored）', () => {
    const buf = buildXlsx(rows);
    const r = parseTimetableFile('课表.xlsx', buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.headers).toEqual(['教师', '班级', '科目', '星期', '节次']);
    expect(r.table.rows).toHaveLength(3);
    expect(r.table.rows[0]).toEqual(['示例教师甲', '虚构一年一班', '语文', '周一', '1']);
    expect(r.table.rows[2]).toEqual(['示例教师甲', '虚构一年一班', '语文', '周三', '3']);
  });

  it('deflate 压缩的条目也能读', () => {
    const buf = buildXlsx(rows, { deflate: true });
    const r = parseTimetableFile('课表.xlsx', buf);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.table.rows).toHaveLength(3);
  });

  it('伪装成 xlsx 的文件报 MALFORMED', () => {
    const r = parseTimetableFile('课表.xlsx', Buffer.from('这不是压缩包'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('MALFORMED');
  });
});

describe('格式选择', () => {
  it('.docx 明确返回 UNSUPPORTED_FORMAT', () => {
    const r = parseTimetableFile('课表.docx', Buffer.from('PK'));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe('UNSUPPORTED_FORMAT');
    expect(r.message).toContain('CSV');
  });

  it('.xls / .pdf 也给出可操作提示', () => {
    for (const name of ['课表.xls', '课表.pdf']) {
      const r = parseTimetableFile(name, Buffer.from('x'));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.code).toBe('UNSUPPORTED_FORMAT');
    }
  });

  it('未知扩展名不被猜测', () => {
    expect(selectParser('课表.txt')).toBeNull();
    const r = parseTimetableFile('课表.txt', Buffer.from('a,b\n1,2\n'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('UNSUPPORTED_FORMAT');
  });

  it('超过大小上限直接拒绝', () => {
    const big = Buffer.alloc(5 * 1024 * 1024 + 1, 0x61);
    const r = parseTimetableFile('课表.csv', big);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('TOO_LARGE');
  });

  it('非 UTF-8 编码明确报错而不是替换字符', () => {
    const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3, 0x0a, 0x31, 0x2c, 0x32, 0x0a]);
    const r = parseTimetableFile('课表.csv', gbk);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('MALFORMED');
  });
});

import { inflateRawSync } from 'node:zlib';

/**
 * 最小 ZIP 读取器：只解析中央目录 + 本地头，支持 stored(0) 与 deflate(8)。
 * 不处理 ZIP64、加密、多卷 —— 课表文件不会用到；遇到就明确报错。
 */
export function readZipEntries(buf: Buffer): Map<string, Buffer> {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const minEocd = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minEocd; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('ZIP_EOCD_NOT_FOUND');

  const entryCount = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (cdOffset === 0xffffffff || entryCount === 0xffff) throw new Error('ZIP64_UNSUPPORTED');

  const out = new Map<string, Buffer>();
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('ZIP_CENTRAL_DIR_CORRUPT');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error('ZIP_LOCAL_HEADER_CORRUPT');
    const localNameLen = buf.readUInt16LE(localOffset + 26);
    const localExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);

    if (method === 0) out.set(name, Buffer.from(raw));
    else if (method === 8) out.set(name, inflateRawSync(raw));
    else throw new Error(`ZIP_METHOD_UNSUPPORTED:${method}`);

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

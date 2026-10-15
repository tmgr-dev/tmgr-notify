export interface TarEntry {
  name: string;
  data?: Buffer;
  type?: string;
  prefix?: string;
  corruptChecksum?: boolean;
}

function field(buf: Buffer, offset: number, len: number, text: string): void {
  buf.write(text.slice(0, len), offset, "utf8");
}

export function tarHeader(entry: TarEntry): Buffer {
  const header = Buffer.alloc(512);
  const size = entry.data?.length ?? 0;
  field(header, 0, 100, entry.name);
  field(header, 100, 8, "0000644\0");
  field(header, 108, 8, "0000000\0");
  field(header, 116, 8, "0000000\0");
  field(header, 124, 12, size.toString(8).padStart(11, "0") + "\0");
  field(header, 136, 12, "00000000000\0");
  field(header, 148, 8, "        ");
  field(header, 156, 1, entry.type ?? "0");
  field(header, 257, 6, "ustar\0");
  field(header, 263, 2, "00");
  if (entry.prefix) field(header, 345, 155, entry.prefix);
  let sum = 0;
  for (const byte of header) sum += byte;
  if (entry.corruptChecksum) sum += 1;
  field(header, 148, 8, sum.toString(8).padStart(6, "0") + "\0 ");
  return header;
}

export function makeTar(entries: TarEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    parts.push(tarHeader(entry));
    if (entry.data && entry.data.length > 0) {
      const padded = Buffer.alloc(Math.ceil(entry.data.length / 512) * 512);
      entry.data.copy(padded);
      parts.push(padded);
    }
  }
  parts.push(Buffer.alloc(1024));
  return Buffer.concat(parts);
}

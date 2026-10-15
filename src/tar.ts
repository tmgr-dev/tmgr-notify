const BLOCK = 512;

function cString(buf: Buffer, start: number, len: number): string {
  const slice = buf.subarray(start, start + len);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? len : end).toString("utf8");
}

function parseOctal(buf: Buffer, start: number, len: number): number {
  const text = cString(buf, start, len).trim();
  if (!/^[0-7]+$/.test(text)) throw new Error("tar: invalid numeric field");
  return parseInt(text, 8);
}

function checksumOk(header: Buffer): boolean {
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) {
    sum += i >= 148 && i < 156 ? 0x20 : header[i];
  }
  const stored = cString(header, 148, 8).trim();
  return /^[0-7]+$/.test(stored) && parseInt(stored, 8) === sum;
}

export function validateWantedName(name: string): void {
  if (
    name === "" ||
    name.startsWith("/") ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.split("/").some((part) => part === ".." || part === "")
  ) {
    throw new Error(`tar: unsafe wanted name ${JSON.stringify(name)}`);
  }
}

export function extractFiles(tarBuffer: Buffer, wanted: string[]): Map<string, Buffer> {
  wanted.forEach(validateWantedName);
  const wantedSet = new Set(wanted);
  const found = new Map<string, Buffer>();
  const seen = new Set<string>();
  let afterExtended = false;
  let offset = 0;

  while (offset + BLOCK <= tarBuffer.length) {
    const header = tarBuffer.subarray(offset, offset + BLOCK);
    if (header.every((byte) => byte === 0)) break;
    if (!checksumOk(header)) throw new Error("tar: header checksum mismatch");

    const prefix = cString(header, 345, 155);
    const base = cString(header, 0, 100);
    const name = prefix ? `${prefix}/${base}` : base;
    const type = String.fromCharCode(header[156]);
    const size = parseOctal(header, 124, 12);
    const dataStart = offset + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tarBuffer.length) throw new Error("tar: entry exceeds archive size");
    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

    if (type === "x" || type === "g" || type === "L" || type === "K") {
      afterExtended = true;
      continue;
    }

    if (wantedSet.has(name)) {
      if (afterExtended) throw new Error(`tar: extended header precedes ${name}`);
      if (seen.has(name)) throw new Error(`tar: duplicate entry ${name}`);
      seen.add(name);
      if (type !== "0" && type !== "\0") throw new Error(`tar: ${name} is not a regular file`);
      found.set(name, Buffer.from(tarBuffer.subarray(dataStart, dataEnd)));
    }
    afterExtended = false;
  }

  for (const name of wanted) {
    if (!found.has(name)) throw new Error(`tar: missing entry ${name}`);
  }
  return found;
}

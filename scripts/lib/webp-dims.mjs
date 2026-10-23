#!/usr/bin/env node
/**
 * 最小 WebP 头解析：只取画布宽高，用来核对 assets/art-manifest.json 里声明的尺寸。
 *
 * 支持三种容器：
 *  - 有损 VP8（帧头在偏移 20 起的 10 字节，宽高各 14 bit）；
 *  - 无损 VP8L（偏移 21 起的 4 字节位域，宽高各 14 bit，存的是「减一」）；
 *  - 扩展 VP8X（偏移 24 起 3+3 字节，存的是「减一」）。
 *
 * 只读文件头，不解码像素；够用且不会引入任何依赖。
 */
import { readFileSync } from 'node:fs';

const RIFF = 0x52494646; // 'RIFF'
const WEBP = 0x57454250; // 'WEBP'
const VP8 = 0x56503820; // 'VP8 '
const VP8L = 0x5650384c; // 'VP8L'
const VP8X = 0x56503858; // 'VP8X'

/**
 * @param {Buffer} buf 完整文件内容（至少 30 字节）
 * @returns {{ width: number, height: number, format: 'VP8' | 'VP8L' | 'VP8X' }}
 */
export function readWebpSize(buf) {
  if (buf.length < 30) throw new Error(`文件太短（${buf.length} 字节），不是 WebP`);
  if (buf.readUInt32BE(0) !== RIFF || buf.readUInt32BE(8) !== WEBP) {
    throw new Error('不是 RIFF/WEBP 容器');
  }
  const chunk = buf.readUInt32BE(12);
  if (chunk === VP8X) {
    return {
      width: buf.readUIntLE(24, 3) + 1,
      height: buf.readUIntLE(27, 3) + 1,
      format: 'VP8X',
    };
  }
  if (chunk === VP8L) {
    if (buf[20] !== 0x2f) throw new Error('VP8L 签名不是 0x2f');
    const bits = buf.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
      format: 'VP8L',
    };
  }
  if (chunk === VP8) {
    // 帧标签 3 字节 + 起始码 9d 01 2a，之后 2 字节宽、2 字节高（各 14 bit）
    if (buf[23] !== 0x9d || buf[24] !== 0x01 || buf[25] !== 0x2a) {
      throw new Error('VP8 起始码不是 9d 01 2a');
    }
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
      format: 'VP8',
    };
  }
  throw new Error(`未知的 WebP chunk：0x${chunk.toString(16)}`);
}

/** 便利函数：直接读路径 */
export function readWebpSizeOf(path) {
  return readWebpSize(readFileSync(path));
}

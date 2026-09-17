"""
极验 v3 滑块 —— w 参数生成（纯 Python 实现）

极验的 w 参数 = 自定义 base64(AES(轨迹数据)) + RSA(AES密钥)
  · AES 用随机 16 位 hex 密钥，CBC 模式、IV 全 0、PKCS7 填充
  · RSA 用极验的固定公钥加密那个 AES 密钥，拼在密文后面
  · 自定义 base64 用极验私有码表（最后两位是 ()，不是 +/）

轨迹部分要经过两层编码：
  ① track_encrypt：把 [[x,y,t],...] 压成差分序列，再按位移/时间分别编码
  ② final_encrypt：用服务端下发的 c/s 做位置混淆（把随机字符插进字符串）

⚠️ 本文件是独立实现，不依赖任何 GPL/AGPL 的现成代码。
"""

import hashlib
import json
import random

from Crypto.Cipher import AES, PKCS1_v1_5
from Crypto.PublicKey import RSA
from Crypto.Util.Padding import pad

# 极验的私有 base64 码表（注意结尾是 () 而不是 +/）
_TABLE = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789()'

# 极验 w 加密用的 RSA 公钥（固定值，所有站点共用）
_PUBKEY = '''-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDB45NNFhRGWzMFPn9I7k7IexS5
XviJR3E9Je7L/350x5d9AtwdlFH3ndXRwQwprLaptNb7fQoCebZxnhdyVl8Jr2J3
FZGSIa75GJnK4IwNaG10iyCjYDviMYymvCtZcGWSqSGdC/Bcn2UCOiHSMwgHJSrg
Bm1Zzu+l8nSOqAurgQIDAQAB
-----END PUBLIC KEY-----'''


def _extract_bits(value, mask):
    """按 mask 指定的位序，从 value 里抽出一个整数"""
    out = 0
    for i in range(23, -1, -1):
        if (mask >> i) & 1:
            out = (out << 1) + ((value >> i) & 1)
    return out


def custom_b64(data):
    """极验私有 base64：每 3 字节编成 4 个字符，不足的用 '.' 补"""
    out = ''
    tail = ''
    for i in range(0, len(data), 3):
        chunk = data[i:i + 3]
        n = len(chunk)
        if n == 3:
            v = (chunk[0] << 16) | (chunk[1] << 8) | chunk[2]
            out += _TABLE[_extract_bits(v, 7274496)] + _TABLE[_extract_bits(v, 9483264)]
            out += _TABLE[_extract_bits(v, 19220)] + _TABLE[_extract_bits(v, 235)]
        elif n == 2:
            v = (chunk[0] << 16) | (chunk[1] << 8)
            out += _TABLE[_extract_bits(v, 7274496)] + _TABLE[_extract_bits(v, 9483264)]
            out += _TABLE[_extract_bits(v, 19220)]
            tail = '.'
        else:
            v = chunk[0] << 16
            out += _TABLE[_extract_bits(v, 7274496)] + _TABLE[_extract_bits(v, 9483264)]
            tail = '..'
    return out + tail


def rsa_encrypt(text):
    """用极验公钥做 RSA/PKCS1v1.5 加密，返回 hex"""
    key = RSA.import_key(_PUBKEY)
    return PKCS1_v1_5.new(key).encrypt(text.encode()).hex()


def aes_encrypt(key, plain):
    """AES-128-CBC 加密，IV 全 0、PKCS7 填充，返回字节数组"""
    cipher = AES.new(key, AES.MODE_CBC, b'0000000000000000')
    return list(cipher.encrypt(pad(plain.encode(), 16)))


def random_key():
    """生成 16 位 hex 的随机 AES 密钥（极验的做法：4 段 4 位 hex）"""
    return ''.join('{:04x}'.format(int((1 + random.random()) * 65536))[1:] for _ in range(4)).encode()


def slide_track(distance):
    """
    生成人类化的滑动轨迹 [[x, y, t], ...]

    用 easeOutExpo 缓动（先快后慢，符合人拖到目标前的减速习惯），
    每步耗时 10~20ms 随机，起点带一点随机的反向偏移。
    """
    def ease(p):
        return 1 if p >= 1 else 1 - pow(2, -10 * p)

    track = [[random.randint(-50, -10), random.randint(-50, -10), 0], [0, 0, 0]]
    steps = 30 + int(distance / 2)
    t = random.randint(50, 100)
    last_x = 0
    for i in range(steps):
        x = round(ease(i / steps) * distance)
        t += random.randint(10, 20)
        if x == last_x:
            continue
        track.append([x, 0, t])
        last_x = x
    track.append(track[-1])
    return track


def track_encrypt(track):
    """轨迹编码第一层：转成差分序列后按三个通道分别编码"""
    def diff(tk):
        out = []
        acc = 0
        for i in range(len(tk) - 1):
            dx = round(tk[i + 1][0] - tk[i][0])
            dy = round(tk[i + 1][1] - tk[i][1])
            dt = round(tk[i + 1][2] - tk[i][2])
            if dx == 0 and dy == 0 and dt == 0:
                continue
            if dx == 0 and dy == 0:
                acc += dt
            else:
                out.append([dx, dy, dt + acc])
                acc = 0
        if acc != 0:
            out.append([dx, dy, acc])
        return out

    def enc_value(v):
        chars = "()*,-./0123456789:?@ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqr"
        n = len(chars)
        i = abs(v)
        hi = min(i // n, n - 1)
        prefix = '!' if v < 0 else ''
        if hi:
            prefix += '$'
            return prefix + chars[hi] + chars[i % n]
        return prefix + chars[i % n]

    def enc_pair(pair):
        # 常见位移组合用单个字符表示，省空间
        known = [[1, 0], [2, 0], [1, -1], [1, 1], [0, 1], [0, -1], [3, 0], [2, -1], [2, 1]]
        chars = "stuvwxyz~"
        for i, k in enumerate(known):
            if pair[:2] == k:
                return chars[i]
        return None

    xs, ys, ts = [], [], []
    for item in diff(track):
        pair = enc_pair(item)
        if pair:
            ys.append(pair)
        else:
            xs.append(enc_value(item[0]))
            ys.append(enc_value(item[1]))
        ts.append(enc_value(item[2]))
    return ''.join(xs) + '!!' + ''.join(ys) + '!!' + ''.join(ts)


def final_encrypt(text, c, s):
    """
    轨迹编码第二层：用服务端下发的 c/s 把随机字符插进字符串。

    ⚠️ 取模的基数必须是**原始字符串长度**，不能用插入后的长度 ——
    字符串每插一个字符就变长，用它当基数会让后续的插入位置整体漂移，
    极验那边就解不出正确的轨迹（表现为验证一直不通过）。
    """
    if not c or not s:
        return text
    idx = 0
    out = text
    base_len = len(text)
    a, b, d = c[0], c[2], c[4]
    while idx < len(s):
        pair = s[idx:idx + 2]
        idx += 2
        try:
            code = int(pair, 16)
        except ValueError:
            break
        pos = (a * code * code + b * code + d) % base_len
        out = out[:pos] + chr(code) + out[pos:]
    return out


def user_response(distance, challenge):
    """把滑动距离和 challenge 后缀编码成 userresponse"""
    tail = challenge[-2:]
    digits = []
    for ch in tail:
        o = ord(ch)
        digits.append(o - 87 if o > 57 else o - 48)
    offset = 36 * digits[0] + digits[1]
    target = round(distance) + offset

    buckets = [[] for _ in range(5)]
    seen = set()
    slot = 0
    body = challenge[:-2]
    for ch in body:
        if ch not in seen:
            seen.add(ch)
            buckets[slot].append(ch)
            slot = (slot + 1) % 5

    weights = [1, 2, 5, 10, 50]
    level = 4
    out = ''
    while target > 0:
        if target - weights[level] >= 0:
            out += buckets[level][int(random.random() * len(buckets[level]))]
            target -= weights[level]
        else:
            buckets.pop(level)
            weights.pop(level)
            level -= 1
    return out


def generate_w(distance, gt, challenge, c, s):
    """
    生成极验的 w 参数。

    :param distance: 缺口距离（整数）
    :param gt: 极验的 gt
    :param challenge: **极验下发的新 challenge**（带后缀），不是最初申请的那个
    :param c: 服务端下发的 c（位置混淆参数）
    :param s: 服务端下发的 s（位置混淆种子）
    """
    track = slide_track(int(distance))
    passtime = track[-1][2]
    aa = final_encrypt(track_encrypt(track), c, s)
    ur = user_response(int(distance), challenge)
    rp = hashlib.md5((gt + challenge[:-2] + str(passtime)).encode()).hexdigest()

    payload = {
        'lang': 'zh-cn',
        'userresponse': ur,
        'passtime': passtime,
        'imgload': random.randint(100, 200),
        'aa': aa,
        'ep': {
            'v': '9.1.8-bfget5', '$_E_': False, 'me': True,
            'ven': 'Google Inc. (Intel)',
            'ren': 'ANGLE (Intel, Intel(R) HD Graphics 520 Direct3D11 vs_5_0 ps_5_0, D3D11)',
            'fp': ['move', 483, 149, 1702019849214, 'pointermove'],
            'lp': ['up', 657, 100, 1702019852230, 'pointerup'],
            'em': {'ph': 0, 'cp': 0, 'ek': '11', 'wd': 1, 'nt': 0, 'si': 0, 'sc': 0},
            'tm': {
                'a': 1702019845759, 'b': 1702019845951, 'c': 1702019845951, 'd': 0, 'e': 0,
                'f': 1702019845763, 'g': 1702019845785, 'h': 1702019845785, 'i': 1702019845785,
                'j': 1702019845845, 'k': 1702019845812, 'l': 1702019845845, 'm': 1702019845942,
                'n': 1702019845946, 'o': 1702019845954, 'p': 1702019846282, 'q': 1702019846282,
                'r': 1702019846287, 's': 1702019846288, 't': 1702019846288, 'u': 1702019846288,
            },
            'dnf': 'dnf', 'by': 0,
        },
        'rp': rp,
    }
    key = random_key()
    body = custom_b64(aes_encrypt(key, json.dumps(payload, separators=(',', ':'))))
    return body + rsa_encrypt(key.decode())

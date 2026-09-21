"""
米游社极验滑块 —— 全自动过码服务

输入 {cookie}，输出 {validate, challenge}，供 Yunzai 插件的 auto_verify_addr 调用。

与旧版（浏览器方案）的区别：
  旧版：起 Xvfb + openbox + Chromium，让极验 JS 自己算 w，再用 xdotool 系统级指针拖滑块。
        单轮 9 秒、成功率约 32%，还要装一堆系统依赖。
  新版：纯 HTTP 协议。直接打极验的 gettype/get/ajax 三个接口拿参数和图片，
        本地算出缺口，再按极验的算法自己生成 w 参数提交。
        单轮约 0.7 秒、成功率约 87%，零系统依赖（不需要 X11 / 浏览器 / xdotool）。

链路：
  ① get_c_s / get_type  热身（模块内部有状态，这两步不能省）
  ② get_new_c_s_args    拿 c/s + 三张图 URL + 新的 challenge
  ③ calculate_key       下载图片 → 还原乱序背景 → 模板匹配出缺口距离
  ④ generate_w          生成 w（见 w.py）
  ⑤ verify              提交，拿 validate

⚠️ 每个 challenge 只能用一次，用完必须重新申请 —— 所以一轮失败就整轮重来。
"""

import json
import os
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import httpx

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from w import generate_w

# 米游社 bbs 通用 DS（salt 是 App 端的固定值）
_DS_SALT = 'xV8v4Qu54lUKrEYFZkJhB8cuOh9Asafs'

PORT = int(os.environ.get('GT_PORT', 8766))
MAX_ROUNDS = int(os.environ.get('GT_MAX_ROUNDS', 8))
CONCURRENCY = int(os.environ.get('GT_CONCURRENCY', 4))

# 过码用的设备参数。必须与调用方后续重试时用的一致，
# 否则米游社侧会认为是不同设备，风险分清不掉。
DEVICE_ID = os.environ.get('GT_DEVICE_ID', 'Yz-probe123')
DEVICE_FP = os.environ.get('GT_DEVICE_FP', '38d7ee834d1e9')
APP_VERSION = os.environ.get('GT_APP_VERSION', '2.40.1')
# 默认按网页端（5）走，调用方可以在请求里指定 clientType=2 切到 App 端形态
CLIENT_TYPE = os.environ.get('GT_CLIENT_TYPE', '5')
UA = f'miHoYoBBS/{APP_VERSION}'

_lock = threading.Lock()
_stats = {'ok': 0, 'fail': 0, 'rounds': 0, 'total_s': 0.0}


def log(*a):
    print(f'[{time.strftime("%Y-%m-%d %H:%M:%S")}]', *a, flush=True)


def _md5(s):
    import hashlib
    return hashlib.md5(s.encode()).hexdigest()


def bbs_ds(query='', body=''):
    """米游社接口的 DS 签名"""
    import random
    t = int(time.time())
    r = random.randint(100000, 999999)
    return f'{t},{r},{_md5(f"salt={_DS_SALT}&t={t}&r={r}&b={body}&q={query}")}'


def bbs_headers(cookie, device_id=None, device_fp=None, client_type=None):
    """device_id / device_fp / client_type 由调用方传入时就用调用方的 —— 过码要跟调用方同一套身份。"""
    return {
        'Cookie': cookie,
        'x-rpc-app_version': APP_VERSION,
        'x-rpc-client_type': str(client_type or CLIENT_TYPE),
        'x-rpc-device_id': device_id or DEVICE_ID,
        'x-rpc-device_fp': device_fp or DEVICE_FP,
        'User-Agent': UA,
        'X-Requested-With': 'com.mihoyo.hyperion',
        'Origin': 'https://webstatic.mihoyo.com',
        'Referer': 'https://webstatic.mihoyo.com',
    }


def _paths(client_type):
    """
    App 端（client_type=2）和网页端（5）的接口路径不同，**必须成套用**。

    ⚠️ 实测（2026-09-22，米游币签到 1034）：只有 App 端那套能解 POST 类接口的风控 ——
       wapi + gids=2 + 拼错的 verifyVerfication，走完米游社照样回 1034；
       换成 api + is_high=false + verifyVerification 才放行（签到一次过）。
       GET 类（质变仪/查询）两套都能用，所以默认仍走网页端，不动老行为。
    """
    if str(client_type or CLIENT_TYPE) == '2':
        return 'misc/api/createVerification', 'is_high=false', 'misc/api/verifyVerification'
    return 'misc/wapi/createVerification', 'gids=2&is_high=false', 'misc/wapi/verifyVerfication'


def create_verification(cookie, device_id=None, device_fp=None, client_type=None):
    """向米游社申请一次极验（拿 gt + challenge）"""
    path, q, _ = _paths(client_type)
    r = httpx.get(
        f'https://bbs-api.miyoushe.com/{path}?{q}',
        headers={**bbs_headers(cookie, device_id, device_fp, client_type), 'DS': bbs_ds(q)},
        timeout=15,
    ).json()
    if r.get('retcode') != 0:
        raise RuntimeError(f'申请极验失败: {json.dumps(r)[:120]}')
    d = r['data']
    return d['gt'], d['challenge']


def verify_verification(cookie, challenge, validate, seccode, device_id=None, device_fp=None, client_type=None):
    """把解出来的 validate 回交给米游社"""
    _, _, path = _paths(client_type)
    body = json.dumps({
        'geetest_challenge': challenge,
        'geetest_validate': validate,
        'geetest_seccode': seccode,
    })
    r = httpx.post(
        f'https://bbs-api.miyoushe.com/{path}',
        headers={**bbs_headers(cookie, device_id, device_fp, client_type), 'Content-Type': 'application/json', 'DS': bbs_ds('', body)},
        content=body,
        timeout=15,
    ).json()
    return r


def _load_solver():
    """延迟加载极验求解模块（它是个 Rust 扩展，导入较慢）"""
    import bili_ticket_gt_python
    return bili_ticket_gt_python.SlidePy()


def solve_round(cookie, round_no, device_id=None, device_fp=None, client_type=None):
    """
    跑一轮完整过码。返回 validate 信息或 None。

    每个 challenge 只能用一次，所以这里一次性走完全部步骤，
    中途失败就整轮作废、由上层重新申请。
    """
    gt, challenge = create_verification(cookie, device_id, device_fp, client_type)
    s = _load_solver()

    # ①② 热身 + 拿参数和三图 URL
    # 这两步看起来多余，但模块内部有状态：不先调 get_c_s/get_type，
    # 后面的 get_new_c_s_args 会报 MissingParam。
    s.get_c_s(gt, challenge)
    vtype = s.get_type(gt, challenge)
    if vtype != 'slide':
        log(f'  [轮{round_no}] 题型是 {vtype}，本服务只支持滑块')
        return None

    c, sv, args = s.get_new_c_s_args(gt, challenge)
    new_challenge = args[0]

    # ③ 算缺口（模块内部下载图片、还原乱序背景、模板匹配）
    distance = s.calculate_key(args)

    # ④ 生成 w
    w = generate_w(distance, gt, new_challenge, list(c), sv)

    # ⑤ 提交
    msg, validate = s.verify(gt, new_challenge, w)
    if not validate:
        return None
    return {'validate': validate, 'challenge': new_challenge, 'distance': distance}


def solve(cookie, device_id=None, device_fp=None, client_type=None):
    """完整过码（含重试 + 回交米游社）"""
    t0 = time.time()
    for r in range(1, MAX_ROUNDS + 1):
        try:
            v = solve_round(cookie, r, device_id, device_fp, client_type)
            if not v:
                continue
            # 回交米游社
            seccode = f'{v["validate"]}|jordan'
            res = verify_verification(cookie, v['challenge'], v['validate'], seccode, device_id, device_fp, client_type)
            if res.get('retcode') == 0:
                dt = time.time() - t0
                with _lock:
                    _stats['ok'] += 1
                    _stats['rounds'] += r
                    _stats['total_s'] += dt
                # 米游社在回执里颁一个 challenge，调用方要拿它当 x-rpc-challenge 重发原请求，
                # 光「清风险」对 POST 类接口（签到）不管用 —— 见 xhh-tl-bbscoin-verify-shortcircuit
                ch = (res.get('data') or {}).get('challenge', '')
                log(f'✅ 过码成功（第 {r} 轮，缺口 {v["distance"]}，{dt:.1f}s）challenge={str(ch)[:16]}…')
                return {'ok': True, 'round': r, 'distance': v['distance'], 'challenge': ch}
            log(f'  [轮{r}] 回交失败: {json.dumps(res)[:100]}')
        except Exception as err:
            log(f'  [轮{r}] 异常: {type(err).__name__}: {str(err)[:150]}')
        time.sleep(0.5)
    with _lock:
        _stats['fail'] += 1
    log(f'❌ {MAX_ROUNDS} 轮均失败（{time.time() - t0:.1f}s）')
    return {'ok': False}


# ══════════ HTTP 服务 ══════════
class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *a):
        pass

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith('/health'):
            with _lock:
                st = dict(_stats)
            total = st['ok'] + st['fail']
            avg_round = (st['rounds'] / st['ok']) if st['ok'] else 0
            avg_s = (st['total_s'] / st['ok']) if st['ok'] else 0
            return self._send(200, {
                'ok': True,
                'stats': {
                    'success': st['ok'], 'failed': st['fail'],
                    'successRate': f'{st["ok"] / total * 100:.0f}%' if total else '-',
                    'avgRounds': f'{avg_round:.1f}', 'avgSeconds': f'{avg_s:.1f}',
                },
            })
        return self._send(404, {'error': 'not found'})

    def do_POST(self):
        try:
            n = int(self.headers.get('Content-Length', 0))
            body = json.loads(self.rfile.read(n) or b'{}')
        except Exception as err:
            return self._send(400, {'error': f'bad json: {err}'})

        # 调用方可指定设备/客户端类型：过码必须与调用方同一套身份，米游社才认
        device_id = (body.get('deviceId') or '').strip() or None
        device_fp = (body.get('deviceFp') or '').strip() or None
        client_type = (body.get('clientType') or '').strip() or None

        # 批量模式：{cookies:[...]}，服务端并发跑
        if isinstance(body.get('cookies'), list):
            list_ck = [c for c in body['cookies'] if c]
            if not list_ck:
                return self._send(400, {'error': 'empty cookies'})
            log(f'收到批量过码请求：{len(list_ck)} 个账号（并发 {CONCURRENCY}）')
            results = [None] * len(list_ck)
            sem = threading.Semaphore(CONCURRENCY)

            def work(i, ck):
                with sem:
                    try:
                        r = solve(ck, device_id, device_fp, client_type)
                        results[i] = {'ok': bool(r.get('ok')), 'round': r.get('round'), 'challenge': r.get('challenge', '')}
                    except Exception as err:
                        log(f'  第 {i + 1} 个账号异常: {err}')
                        results[i] = {'ok': False}

            threads = [threading.Thread(target=work, args=(i, ck)) for i, ck in enumerate(list_ck)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            return self._send(200, {'msg': '', 'data': {'results': results}})

        # 单个模式：{cookie}
        cookie = body.get('cookie', '')
        if not cookie:
            return self._send(400, {'error': 'missing cookie'})
        log('收到过码请求')
        r = solve(cookie, device_id, device_fp, client_type)
        if not r.get('ok'):
            return self._send(500, {'error': 'verify failed'})
        return self._send(200, {'msg': '', 'data': {'result': 'ok', 'round': r['round'], 'challenge': r.get('challenge', '')}})


def self_check():
    """启动自检：缺依赖现在就说清楚，别等过码时才报错"""
    problems = []
    try:
        import bili_ticket_gt_python  # noqa: F401
    except ImportError:
        problems.append('缺少 bili-ticket-gt-python，执行：pip install bili-ticket-gt-python==0.2.5')
    except OSError as err:
        # 常见于 glibc 版本过低（该包需要 glibc >= 2.31）
        problems.append(f'bili-ticket-gt-python 加载失败（{err}）。若提示 glibc 版本过低，请升级系统或换台机器')
    try:
        import Crypto  # noqa: F401
    except ImportError:
        problems.append('缺少 pycryptodome，执行：pip install pycryptodome')
    try:
        import httpx  # noqa: F401
    except ImportError:
        problems.append('缺少 httpx，执行：pip install httpx')
    if problems:
        log('⚠️ 启动自检发现问题：')
        for p in problems:
            log('   - ' + p)
    else:
        log('启动自检通过')


if __name__ == '__main__':
    log(f'米游社过码服务已启动 http://127.0.0.1:{PORT}（最多 {MAX_ROUNDS} 轮/次）')
    self_check()
    ThreadingHTTPServer(('127.0.0.1', PORT), Handler).serve_forever()

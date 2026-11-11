# -*- coding: utf-8 -*-
"""
生成无线电语音：用 Windows 自带的 SAPI 男声念一句，再过一遍"1940 年代电台"的处理链。

为什么不用浏览器自带的 speechSynthesis：
  · 每台机器装的声音不一样，B 站录出来一把声音，观众打开又是另一把
  · 语音合成是"干净的"，进不了 WebAudio 的效果链，加不上电台味
  · 这里烤成 wav 之后，任何浏览器、file:// 直接打开，听到的都是同一句

跑法： python tools/gen-voice.py
产物： assets/voice/<key>.wav   （16 kHz 单声道，约 1 MB 全部）
"""

import io
import os
import subprocess
import sys
import wave

import numpy as np

SR = 16000
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'assets', 'voice')
TMP = os.path.join(os.environ.get('TEMP', '/tmp'), 'voice_raw')

# key, 台词, 语速(-10..10)
LINES = [
    ('generalQuarters', 'General quarters! All hands to battle stations!', 1),
    ('radarContact',    'Radar contact! New surface contact, bearing zero seven zero!', 1),
    ('allGuns',         'All guns, commence firing!', 2),
    ('fire',            'Fire!', 3),
    ('torpedo',         'Torpedo! Torpedo in the water!', 3),
    ('hit',             "We're hit! We're hit!", 2),
    ('fireOnBoard',     'Fire on board! Fire on board!', 2),
    ('flooding',        'Flooding! Damage control party, close up!', 1),
    ('sinking',         'Abandon ship! All hands, abandon ship!', 1),
    ('targetSunk',      'Target destroyed. Shift fire.', 1),
    ('ceaseFire',       'Cease fire! Cease fire!', 2),
    ('plane',           'Floatplane airborne. Beginning search pattern.', 0),
    ('dcReport',        'Damage control reports flooding under control.', 0),
    ('warning',         'Warning! Warning!', 2),
    ('torpedoAway',     'Torpedoes away! Torpedoes away!', 2),
    ('contact',         'Contact! Bearing zero seven zero, range eight thousand yards!', 1),
]


def say(text, rate, path):
    """让 SAPI 念一句，存成 wav。"""
    script = (
        'Add-Type -AssemblyName System.Speech;'
        '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;'
        "$s.SelectVoice('Microsoft David Desktop');"
        '$s.Rate = %d;'
        "$s.SetOutputToWaveFile('%s');"
        "$s.Speak('%s');"
        '$s.Dispose();' % (rate, path.replace('\\', '\\\\'), text.replace("'", "''"))
    )
    r = subprocess.run(['powershell', '-NoProfile', '-Command', script],
                       capture_output=True, text=True)
    if r.returncode != 0 or not os.path.exists(path):
        raise RuntimeError('SAPI 失败: ' + (r.stderr or r.stdout)[:400])


def read_wav(path):
    with wave.open(path, 'rb') as w:
        n = w.getnframes()
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        raw = w.readframes(n)
    if sw != 2:
        raise RuntimeError('只支持 16 位 wav，拿到 %d 位' % (sw * 8))
    x = np.frombuffer(raw, dtype='<i2').astype(np.float64) / 32768.0
    if ch > 1:
        x = x.reshape(-1, ch).mean(axis=1)
    return x, sr


def resample(x, sr, target=SR):
    if sr == target:
        return x
    n = int(round(len(x) * target / float(sr)))
    xi = np.linspace(0, len(x) - 1, n)
    return np.interp(xi, np.arange(len(x)), x)


def band(x, lo, hi, soft=0.18):
    """频域带通，边缘用升余弦过渡，避免砖墙滤波的振铃。"""
    n = len(x)
    if n < 32:
        return x
    spec = np.fft.rfft(x)
    f = np.fft.rfftfreq(n, 1.0 / SR)
    mask = np.ones_like(f)
    width_lo = lo * soft
    width_hi = hi * soft
    mask *= np.clip((f - (lo - width_lo)) / (2 * width_lo + 1e-9), 0, 1)
    mask *= np.clip(((hi + width_hi) - f) / (2 * width_hi + 1e-9), 0, 1)
    return np.fft.irfft(spec * mask, n)


def rms(x):
    return float(np.sqrt(np.mean(x ** 2) + 1e-12))


def make_squelch(seconds=0.055):
    n = int(SR * seconds)
    nz = np.random.RandomState(7).randn(n)
    nz = band(nz, 900, 4200)
    env = np.exp(-np.linspace(0, 6, n))
    env[:8] *= np.linspace(0, 1, 8)
    click = np.zeros(n)
    click[:6] = [0.9, -0.5, 0.3, -0.2, 0.1, -0.05]
    return nz * env * 0.5 + band(click, 600, 5000)


def make_tail(seconds=0.16):
    n = int(SR * seconds)
    nz = np.random.RandomState(11).randn(n)
    nz = band(nz, 400, 3000)
    env = np.exp(-np.linspace(0, 7, n))
    return nz * env * 0.22


def radiofy(x):
    """把干声做成电台音：带通 + 软削波 + 底噪 + 静噪头尾。"""
    x = resample(x, SR)
    # 去掉首尾静音
    env = np.abs(x)
    thr = max(env.max() * 0.02, 1e-4)
    idx = np.where(env > thr)[0]
    if len(idx):
        x = x[max(0, idx[0] - 200): idx[-1] + 200]

    x = band(x, 330, 3000)                      # 话音频段
    x = np.tanh(x * 2.6) / np.tanh(2.6)         # 轻微过载，像老发射机
    x = x / (rms(x) + 1e-9) * 0.16              # 归一化到固定电平

    # 底噪：一直有的嘶嘶声，说话时略涨
    n = len(x)
    bed = band(np.random.RandomState(3).randn(n), 500, 2600) * 0.018
    speech_env = np.clip(np.abs(x) * 6, 0, 1)
    x = x + bed * (0.6 + 0.8 * speech_env)

    # 电台特有的轻微抖动（AM 衰落）
    t = np.arange(n) / SR
    x = x * (1 + 0.06 * np.sin(2 * np.pi * 3.1 * t + 1.2))

    head = make_squelch()
    tail = make_tail()
    return np.concatenate([head, x, tail])


def write_wav(path, x):
    x = np.clip(x, -1, 1)
    peak = np.abs(x).max()
    if peak > 0:
        x = x / peak * 0.89                     # 留 1 dB 余量
    data = (x * 32767).astype('<i2').tobytes()
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SR)
        w.writeframes(data)


def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(TMP, exist_ok=True)
    np.random.seed(5)
    total = 0
    for key, text, rate in LINES:
        raw = os.path.join(TMP, key + '.wav')
        say(text, rate, raw)
        x, sr = read_wav(raw)
        y = radiofy(x)
        dst = os.path.join(OUT, key + '.wav')
        write_wav(dst, y)
        size = os.path.getsize(dst)
        total += size
        print('  %-16s %5.2f 秒  %6.1f KB' % (key, len(y) / float(SR), size / 1024.0))
    print('\n共 %d 条，%.1f KB' % (len(LINES), total / 1024.0))


if __name__ == '__main__':
    main()

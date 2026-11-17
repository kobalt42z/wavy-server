import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideWavy } from '../core/config';
import { PlaybackError } from '../core/errors';
import { WavyAudioComponent } from './wavy-audio.component';

type Route = (body: unknown, url: URL) => [number, unknown, Record<string, string>?];

/** A fake playback API: "METHOD /path" → handler. Records every call. */
function fakeApi(routes: Record<string, Route>) {
  const calls: { method: string; path: string; search: string; body: unknown; init: RequestInit }[] = [];
  const fetch = async (url: RequestInfo | URL, init: RequestInit = {}) => {
    const method = init.method ?? 'GET';
    const u = new URL(String(url), 'http://test.local');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path: u.pathname, search: u.search, body, init });
    const route = routes[`${method} ${u.pathname}`];
    if (!route) return new Response(JSON.stringify({ error: 'not_found', reason: 'No such endpoint.' }), { status: 404 });
    const [status, json, headers] = route(body, u);
    return new Response(json === undefined ? null : JSON.stringify(json), { status, headers });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

const PEAKS = Array.from({ length: 200 }, (_, i) => Math.abs(Math.sin(i / 7)));

@Component({
  imports: [WavyAudioComponent],
  template: `
    <wavy-audio [path]="path()" (playbackError)="errors.push($event)" />
    <wavy-audio path="other.ogg" />
  `,
})
class Host {
  path = signal('voice/note.ogg');
  errors: PlaybackError[] = [];
}

describe('WavyAudioComponent', () => {
  let api: ReturnType<typeof fakeApi>;
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
    }
    fixture.detectChanges();
  };

  async function create(routes: Record<string, Route> = {}) {
    api = fakeApi({
      'GET /api/peaks': (_b, u) => [200, { path: u.searchParams.get('path'), duration: 17, count: 200, peaks: PEAKS }],
      'GET /api/probe': () => [200, { mode: 'direct', duration: 17, reason: 'ok' }],
      'POST /api/sessions': (body) => [201, { sessionId: 's1', mode: 'direct', url: '/api/sessions/s1/file', start: 0, duration: 17, reason: 'ok', body }],
      'DELETE /api/sessions/s1': () => [204, undefined],
      ...routes,
    });
    TestBed.configureTestingModule({
      providers: [provideZonelessChangeDetection(), provideWavy({ fetch: api.fetch, stopOnPageHide: false })],
    });
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: false });
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
      Object.defineProperty(this, 'paused', { configurable: true, value: true });
      this.dispatchEvent(new Event('pause'));
    });
  });


  const first = () => el.querySelectorAll('wavy-audio')[0] as HTMLElement;

  it('draws the waveform from /api/peaks and shows the length, without starting a session', async () => {
    await create();
    const peaks = api.calls.find((c) => c.path === '/api/peaks' && c.search.includes('note.ogg'))!;
    expect(peaks.search).toContain('count=200');
    const bars = first().querySelectorAll('.wavy-audio__bar');
    expect(bars.length).toBeGreaterThanOrEqual(8);
    const heights = [...bars].map((b) => (b as HTMLElement).style.height);
    expect(new Set(heights).size).toBeGreaterThan(2);
    expect(first().querySelector('.wavy-audio__time')!.textContent!.trim()).toBe('0:17');
    expect(api.calls.some((c) => c.path === '/api/sessions')).toBe(false);
  });

  it('starts the session on the first play and shows the elapsed time', async () => {
    await create();
    (first().querySelector('.wavy-audio__play') as HTMLButtonElement).click();
    await settle();
    const start = api.calls.find((c) => c.method === 'POST' && c.path === '/api/sessions')!;
    expect(start.body).toEqual({ path: 'voice/note.ogg' });
    const audio = first().querySelector('audio')!;
    expect(audio.getAttribute('src')).toBe('/api/sessions/s1/file');
    expect(first().classList).toContain('wavy-audio--playing');
    expect(first().querySelector('.wavy-audio__play')!.getAttribute('aria-label')).toBe('Pause');

    Object.defineProperty(audio, 'currentTime', { configurable: true, writable: true, value: 4.2 });
    audio.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(first().querySelector('.wavy-audio__time')!.textContent!.trim()).toBe('0:04');
    expect(first().querySelectorAll('.wavy-audio__bar--played').length).toBeGreaterThan(0);
  });

  it('a tap on the waveform before playing sets where playback starts', async () => {
    await create();
    const wave = first().querySelector('.wavy-audio__wave') as HTMLElement;
    vi.spyOn(wave, 'getBoundingClientRect').mockReturnValue({ left: 0, width: 200, top: 0, height: 30 } as DOMRect);
    const ev = (type: string, x: number) => {
      const e = new MouseEvent(type, { clientX: x, button: 0, bubbles: true });
      Object.defineProperty(e, 'pointerId', { value: 1 });
      wave.dispatchEvent(e);
    };
    ev('pointerdown', 100);
    ev('pointerup', 100);
    await settle();
    expect(first().querySelector('.wavy-audio__time')!.textContent!.trim()).toBe('0:08');
    (first().querySelector('.wavy-audio__play') as HTMLButtonElement).click();
    await settle();
    const start = api.calls.find((c) => c.method === 'POST' && c.path === '/api/sessions')!;
    expect(start.body).toEqual({ path: 'voice/note.ogg', start: 8.5 });
  });

  it('only one player plays at a time', async () => {
    await create({
      'POST /api/sessions': (body) => {
        const id = (body as { path: string }).path === 'other.ogg' ? 's2' : 's1';
        return [201, { sessionId: id, mode: 'direct', url: `/api/sessions/${id}/file`, start: 0, duration: 17 }];
      },
    });
    const [a, b] = [...el.querySelectorAll('wavy-audio')] as HTMLElement[];
    (a.querySelector('.wavy-audio__play') as HTMLButtonElement).click();
    await settle();
    (b.querySelector('.wavy-audio__play') as HTMLButtonElement).click();
    await settle();
    expect(a.classList).not.toContain('wavy-audio--playing');
    expect(b.classList).toContain('wavy-audio--playing');
  });

  it('shows the reason when the file cannot be played', async () => {
    const reason = 'g64x is a Genetec proprietary format.';
    await create({ 'GET /api/peaks': () => [422, { error: 'unsupported', reason }] });
    expect(first().querySelector('.wavy-audio__error')!.textContent!.trim()).toBe(reason);
    expect(fixture.componentInstance.errors[0].code).toBe('unsupported');
  });

  it('keeps placeholder bars when the server has no waveform endpoint', async () => {
    await create({ 'GET /api/peaks': () => [404, { error: 'not_found', reason: 'No such endpoint.' }] });
    expect(first().querySelector('.wavy-audio__error')).toBeNull();
    expect(first().querySelector('.wavy-audio__wave--loading')).not.toBeNull();
    expect(first().querySelectorAll('.wavy-audio__bar').length).toBeGreaterThan(0);
  });

  it('the speed button cycles 1x, 1.5x, 2x', async () => {
    await create();
    const speed = first().querySelector('.wavy-audio__speed') as HTMLButtonElement;
    const audio = first().querySelector('audio')!;
    speed.click();
    audio.dispatchEvent(new Event('ratechange'));
    await settle();
    expect(audio.playbackRate).toBe(1.5);
    expect(speed.textContent!.trim()).toBe('1.5×');
    speed.click();
    speed.click();
    expect(audio.playbackRate).toBe(1);
  });
});

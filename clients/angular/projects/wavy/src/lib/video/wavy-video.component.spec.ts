import { Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideWavy } from '../core/config';
import { PlaybackError } from '../core/errors';
import { HLS_LOADER } from '../core/hls-loader';
import { WavyVideoComponent } from './wavy-video.component';

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

/** Minimal hls.js stand-in. */
class FakeHls {
  static Events = { ERROR: 'hlsError' };
  static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  static instances: FakeHls[] = [];
  static isSupported() {
    return true;
  }
  source = '';
  handlers: Record<string, ((e: string, d: unknown) => void)[]> = {};
  destroyed = false;
  constructor(public config: unknown) {
    FakeHls.instances.push(this);
  }
  on(e: string, fn: (e: string, d: unknown) => void) {
    (this.handlers[e] ??= []).push(fn);
  }
  emit(e: string, d: unknown) {
    for (const fn of this.handlers[e] ?? []) fn(e, d);
  }
  loadSource(url: string) {
    this.source = url;
  }
  attachMedia() {}
  recoverMediaError() {}
  destroy() {
    this.destroyed = true;
  }
}

@Component({
  imports: [WavyVideoComponent],
  template: `<wavy-video
    [path]="path()"
    [start]="start()"
    (playbackError)="errors.push($event)"
    (resumed)="resumes.push($event)"
  />`,
})
class Host {
  path = signal('cctv/cam3.dav');
  start = signal<number | undefined>(undefined);
  errors: PlaybackError[] = [];
  resumes: number[] = [];
}

describe('WavyVideoComponent', () => {
  let api: ReturnType<typeof fakeApi>;
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  let sessions = 0;

  const settle = async () => {
    for (let i = 0; i < 4; i++) {
      await fixture.whenStable();
      await new Promise((r) => setTimeout(r, 0));
    }
    fixture.detectChanges();
  };

  async function create(routes: Record<string, Route> = {}) {
    sessions = 0;
    FakeHls.instances = [];
    api = fakeApi({
      'GET /api/probe': () => [200, { mode: 'transcode', duration: 300, reason: 'HEVC video' }],
      'POST /api/sessions': (body) => {
        const id = `s${++sessions}`;
        const start = (body as { start?: number }).start ?? 0;
        return [201, { sessionId: id, mode: 'transcode', url: `/api/sessions/${id}/index.m3u8`, start, duration: 300 }];
      },
      'DELETE /api/sessions/s1': () => [204, undefined],
      'DELETE /api/sessions/s2': () => [204, undefined],
      ...routes,
    });
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        provideWavy({ fetch: api.fetch, stopOnPageHide: false }),
        { provide: HLS_LOADER, useValue: async () => FakeHls },
      ],
    });
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    fixture.detectChanges();
    await settle();
  }

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    });
    vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(function (this: HTMLMediaElement) {
      this.dispatchEvent(new Event('pause'));
    });
  });

  const time = () => el.querySelector('.wavy-video__time')!.textContent!.trim();

  it('probes to show the length, and starts nothing until play', async () => {
    await create();
    expect(time()).toBe('0:00 / 5:00');
    expect(el.querySelector('.wavy-video__big-play')).not.toBeNull();
    expect(api.calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/probe']);
  });

  it('plays HLS through hls.js after the first click', async () => {
    await create();
    (el.querySelector('.wavy-video__big-play') as HTMLButtonElement).click();
    await settle();
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ path: 'cctv/cam3.dav' });
    expect(FakeHls.instances).toHaveLength(1);
    expect(FakeHls.instances[0].source).toBe('/api/sessions/s1/index.m3u8');
    expect(el.querySelector('.wavy-video__btn')!.getAttribute('aria-label')).toBe('Pause');
  });

  it('starts at [start] and shows absolute time after a server-side seek', async () => {
    await create();
    fixture.componentInstance.start.set(120);
    await settle();
    expect(time()).toBe('2:00 / 5:00');
    (el.querySelector('.wavy-video__big-play') as HTMLButtonElement).click();
    await settle();
    expect(api.calls.find((c) => c.method === 'POST')!.body).toEqual({ path: 'cctv/cam3.dav', start: 120 });
    const video = el.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 3 });
    video.dispatchEvent(new Event('timeupdate'));
    await settle();
    expect(time()).toBe('2:03 / 5:00');
  });

  it('restarts a lost session (404) at the same position', async () => {
    await create();
    (el.querySelector('.wavy-video__big-play') as HTMLButtonElement).click();
    await settle();
    const video = el.querySelector('video')!;
    Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 42 });
    FakeHls.instances[0].emit('hlsError', { fatal: true, type: 'networkError', response: { code: 404 } });
    await settle();
    const starts = api.calls.filter((c) => c.method === 'POST' && c.path === '/api/sessions');
    expect(starts.at(-1)!.body).toEqual({ path: 'cctv/cam3.dav', start: 42 });
    expect(fixture.componentInstance.resumes).toEqual([42]);
    expect(FakeHls.instances.at(-1)!.source).toBe('/api/sessions/s2/index.m3u8');
    expect(fixture.componentInstance.errors).toEqual([]);
  });

  it('shows the reason for an unsupported file without a retry button', async () => {
    const reason = 'g64x is a Genetec proprietary format. Export it from Genetec Security Center first.';
    await create({ 'GET /api/probe': () => [200, { mode: 'unsupported', reason, duration: null }] });
    expect(el.querySelector('.wavy-video__big-play')).toBeNull();
    expect(el.querySelector('.wavy-video__error p')!.textContent!.trim()).toBe(reason);
    expect(el.querySelector('.wavy-video__error button')).toBeNull();
    expect(api.calls.some((c) => c.method === 'POST')).toBe(false);
    expect(fixture.componentInstance.errors[0].code).toBe('unsupported');
  });

  it('reports a forbidden file as soon as it is probed', async () => {
    await create({ 'GET /api/probe': () => [403, { error: 'forbidden', reason: 'Your access token does not cover this file.' }] });
    expect(el.querySelector('.wavy-video__error p')!.textContent).toContain('access token');
  });

  it('changing the path stops the old session', async () => {
    await create();
    (el.querySelector('.wavy-video__big-play') as HTMLButtonElement).click();
    await settle();
    fixture.componentInstance.path.set('other.mov');
    await settle();
    expect(api.calls.some((c) => c.method === 'DELETE' && c.path === '/api/sessions/s1')).toBe(true);
    expect(FakeHls.instances[0].destroyed).toBe(true);
  });
});

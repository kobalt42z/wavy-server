import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { HLS_LOADER, HlsConstructor } from './hls-loader';
import { StreamSupportDirective } from './stream-support.directive';
import { StreamEngine, StreamError, StreamInput } from './types';

/** Records what the directive does with hls.js. */
class FakeHls {
  static Events = { ERROR: 'hlsError' };
  static ErrorTypes = { NETWORK_ERROR: 'networkError', MEDIA_ERROR: 'mediaError' };
  static supported = true;
  static instances: FakeHls[] = [];
  static isSupported() {
    return FakeHls.supported;
  }

  media: HTMLMediaElement | null = null;
  source: string | null = null;
  destroyed = false;
  recoveries = 0;
  private handlers: Record<string, ((event: string, data: unknown) => void)[]> = {};

  constructor(public config: unknown) {
    FakeHls.instances.push(this);
  }
  on(event: string, fn: (event: string, data: unknown) => void) {
    (this.handlers[event] ??= []).push(fn);
  }
  attachMedia(media: HTMLMediaElement) {
    this.media = media;
  }
  loadSource(url: string) {
    this.source = url;
  }
  recoverMediaError() {
    this.recoveries++;
  }
  destroy() {
    this.destroyed = true;
  }
  emit(event: string, data: unknown) {
    for (const fn of this.handlers[event] ?? []) fn(event, data);
  }
}

@Component({
  imports: [StreamSupportDirective],
  template: `<video
    [streamSupport]="stream()"
    [hlsConfig]="{ maxBufferLength: 10 }"
    #player="streamSupport"
    (streamError)="errors.push($event)"
    (streamUnsupported)="unsupported.push($event)"
    (streamReady)="ready.push($event)"
  ></video>`,
})
class Host {
  stream = signal<StreamInput>(null);
  errors: StreamError[] = [];
  unsupported: string[] = [];
  ready: StreamEngine[] = [];
}

describe('StreamSupportDirective', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let video: HTMLVideoElement;
  let directive: StreamSupportDirective;
  let loadHls: ReturnType<typeof vi.fn>;
  let canPlayHls: boolean;

  beforeEach(async () => {
    FakeHls.instances = [];
    FakeHls.supported = true;
    canPlayHls = false;
    vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, 'canPlayType').mockImplementation((type: string) =>
      canPlayHls && type === 'application/vnd.apple.mpegurl' ? 'maybe' : '',
    );
    loadHls = vi.fn(() => Promise.resolve(FakeHls as unknown as HlsConstructor));

    TestBed.configureTestingModule({ providers: [{ provide: HLS_LOADER, useValue: loadHls }] });
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    video = fixture.nativeElement.querySelector('video');
    directive = fixture.debugElement.children[0].injector.get(StreamSupportDirective);
    await fixture.whenStable();
  });

  async function play(stream: StreamInput) {
    host.stream.set(stream);
    await fixture.whenStable();
  }

  it('plays direct files through src without loading hls.js', async () => {
    await play({ sessionId: 's1', mode: 'direct', url: '/api/files/a.mp4' });
    expect(video.getAttribute('src')).toBe('/api/files/a.mp4');
    expect(directive.engine()).toBe('native');
    expect(loadHls).not.toHaveBeenCalled();
  });

  it('treats a bare URL as direct, and an .m3u8 URL as HLS', async () => {
    await play('/media/clip.webm');
    expect(video.getAttribute('src')).toBe('/media/clip.webm');

    await play('/api/sessions/s1/index.m3u8?token=x');
    expect(video.hasAttribute('src')).toBe(false);
    expect(FakeHls.instances[0].source).toBe('/api/sessions/s1/index.m3u8?token=x');
  });

  it('uses hls.js for HLS when the browser has no native HLS', async () => {
    await play({ mode: 'transcode', url: '/api/sessions/s1/index.m3u8' });
    const hls = FakeHls.instances[0];
    expect(hls.media).toBe(video);
    expect(hls.source).toBe('/api/sessions/s1/index.m3u8');
    expect(hls.config).toEqual({ maxBufferLength: 10 });
    expect(directive.engine()).toBe('hls.js');
  });

  it('uses native HLS when the browser supports it', async () => {
    canPlayHls = true;
    await play({ mode: 'remux', url: '/api/sessions/s1/index.m3u8' });
    expect(video.getAttribute('src')).toBe('/api/sessions/s1/index.m3u8');
    expect(directive.engine()).toBe('native-hls');
    expect(loadHls).not.toHaveBeenCalled();
  });

  it('destroys the old hls.js player when the stream changes', async () => {
    await play({ mode: 'transcode', url: '/a.m3u8' });
    await play({ mode: 'direct', url: '/b.mp4' });
    expect(FakeHls.instances[0].destroyed).toBe(true);
    expect(video.getAttribute('src')).toBe('/b.mp4');
  });

  it('clears the source when the stream is removed or the element is destroyed', async () => {
    await play({ mode: 'direct', url: '/a.mp4' });
    await play(null);
    expect(video.hasAttribute('src')).toBe(false);
    expect(directive.engine()).toBeNull();

    await play({ mode: 'transcode-audio', url: '/a.m3u8' });
    fixture.destroy();
    expect(FakeHls.instances[0].destroyed).toBe(true);
  });

  it('does not reload when the parent passes an equal stream object', async () => {
    await play({ mode: 'transcode', url: '/a.m3u8' });
    await play({ mode: 'transcode', url: '/a.m3u8' });
    expect(FakeHls.instances.length).toBe(1);
    expect(FakeHls.instances[0].destroyed).toBe(false);
  });

  it('ignores hls.js arriving after the stream already changed', async () => {
    let resolve!: (h: HlsConstructor) => void;
    loadHls.mockImplementationOnce(() => new Promise<HlsConstructor>((r) => (resolve = r)));
    host.stream.set({ mode: 'transcode', url: '/slow.m3u8' });
    fixture.detectChanges();
    await play({ mode: 'direct', url: '/fast.mp4' });
    resolve(FakeHls as unknown as HlsConstructor);
    await fixture.whenStable();
    expect(FakeHls.instances.length).toBe(0);
    expect(video.getAttribute('src')).toBe('/fast.mp4');
  });

  it('reports unsupported files with the service reason', async () => {
    await play({ mode: 'unsupported', reason: 'g64x is a Genetec proprietary format.' });
    expect(host.unsupported).toEqual(['g64x is a Genetec proprietary format.']);
    expect(host.errors).toEqual([{ kind: 'unsupported', message: 'g64x is a Genetec proprietary format.' }]);
    expect(directive.error()?.kind).toBe('unsupported');
    expect(video.hasAttribute('src')).toBe(false);
  });

  it('reports a stream without a URL', async () => {
    await play({ mode: 'direct' });
    expect(host.errors[0].kind).toBe('invalid-stream');
  });

  it('reports browsers that cannot play HLS at all', async () => {
    FakeHls.supported = false;
    await play({ mode: 'remux', url: '/a.m3u8' });
    expect(host.errors[0].kind).toBe('hls-unsupported');
  });

  it('reports when hls.js fails to load', async () => {
    loadHls.mockImplementationOnce(() => Promise.reject(new Error('chunk failed')));
    await play({ mode: 'remux', url: '/a.m3u8' });
    expect(host.errors[0].kind).toBe('hls-load-failed');
  });

  it('recovers once from a fatal hls.js media error, then reports it', async () => {
    await play({ mode: 'transcode', url: '/a.m3u8' });
    const hls = FakeHls.instances[0];
    hls.emit('hlsError', { fatal: false, type: 'networkError' });
    hls.emit('hlsError', { fatal: true, type: 'mediaError' });
    expect(hls.recoveries).toBe(1);
    expect(host.errors).toEqual([]);

    hls.emit('hlsError', { fatal: true, type: 'mediaError' });
    expect(host.errors[0].kind).toBe('media');
    expect(hls.destroyed).toBe(true);
  });

  it('reports fatal hls.js network errors', async () => {
    await play({ mode: 'transcode', url: '/a.m3u8' });
    FakeHls.instances[0].emit('hlsError', { fatal: true, type: 'networkError' });
    expect(host.errors[0].kind).toBe('network');
  });

  it('reports native media errors', async () => {
    await play({ mode: 'direct', url: '/a.mp4' });
    Object.defineProperty(video, 'error', { configurable: true, value: { code: 4 } });
    video.dispatchEvent(new Event('error'));
    expect(host.errors[0]).toMatchObject({ kind: 'media', message: 'This format is not supported by the browser.' });
  });

  it('emits streamReady with the engine once metadata loads', async () => {
    await play({ mode: 'direct', url: '/a.mp4' });
    video.dispatchEvent(new Event('loadedmetadata'));
    expect(host.ready).toEqual(['native']);
  });

  it('offsets position by the stream start and uses the full duration', async () => {
    await play({ mode: 'transcode', url: '/a.m3u8', start: 120, duration: 600 });
    Object.defineProperty(video, 'currentTime', { configurable: true, value: 5 });
    video.dispatchEvent(new Event('timeupdate'));
    expect(directive.position()).toBe(125);
    expect(directive.totalDuration()).toBe(600);
  });
});

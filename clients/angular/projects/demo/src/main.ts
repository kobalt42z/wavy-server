import { ChangeDetectionStrategy, Component, provideZonelessChangeDetection, signal } from '@angular/core';
import { bootstrapApplication } from '@angular/platform-browser';
import { PlaybackError, WavyAudioComponent, WavyVideoComponent, describeError, provideWavy } from '@wavy/angular';

// Settings come from the URL so the demo can point at any server:
//   /?api=http://localhost:8080&video=video/mp4_h264_aac.mp4&audio=audio/mp3.mp3,audio/wma.wma&token=…
const params = new URLSearchParams(location.search);
const list = (name: string, def: string[]) => (params.get(name) ? params.get(name)!.split(',').filter(Boolean) : def);

@Component({
  selector: 'app-root',
  imports: [WavyVideoComponent, WavyAudioComponent],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <h1>&#64;wavy/angular</h1>
      @for (path of videos; track path) {
        <section>
          <h2>{{ path }}</h2>
          <wavy-video [path]="path" (playbackError)="log(path, $event)" (resumed)="log(path, 'resumed at ' + $event)" />
        </section>
      }
      <section class="chat">
        <h2>Voice messages</h2>
        @for (path of audios; track path; let odd = $odd) {
          <div class="row" [class.mine]="odd">
            <wavy-audio [path]="path" (playbackError)="log(path, $event)" />
            <small>{{ path }}</small>
          </div>
        }
      </section>
      @if (events().length) {
        <section>
          <h2>Events</h2>
          <ul class="log">
            @for (e of events(); track $index) { <li>{{ e }}</li> }
          </ul>
        </section>
      }
    </main>
  `,
  styles: `
    main { max-width: 760px; margin: 0 auto; padding: 16px; }
    h1 { font-size: 20px; }
    h2 { font-size: 13px; font-weight: 600; opacity: 0.7; margin: 20px 0 8px; }
    .chat .row { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; margin: 10px 0; }
    .chat .row.mine { align-items: flex-end; }
    .chat .row.mine wavy-audio { --wavy-audio-bg: #d9fdd3; --wavy-audio-accent: #1daa61; }
    @media (prefers-color-scheme: dark) {
      .chat .row.mine wavy-audio { --wavy-audio-bg: #005c4b; --wavy-audio-accent: #21c063; --wavy-audio-fg: #d1e7dd; }
    }
    small { opacity: 0.6; font-size: 11px; }
    .log { font: 12px/1.4 ui-monospace, monospace; padding-left: 18px; }
  `,
})
class App {
  readonly videos = list('video', ['video/mp4_h264_aac.mp4']);
  readonly audios = list('audio', ['audio/mp3.mp3', 'audio/opus.opus', 'audio/wma.wma']);
  readonly events = signal<string[]>([]);

  log(path: string, e: PlaybackError | string): void {
    const text = typeof e === 'string' ? e : describeError(e);
    this.events.update((list) => [...list, `${path}: ${text}`]);
  }
}

const token = params.get('token');
bootstrapApplication(App, {
  providers: [
    provideZonelessChangeDetection(),
    provideWavy({
      apiBase: params.get('api') ?? '',
      withCredentials: params.get('credentials') === '1',
      getToken: token ? () => token : undefined,
    }),
  ],
}).catch((err) => console.error(err));

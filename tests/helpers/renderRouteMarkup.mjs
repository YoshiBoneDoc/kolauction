import { Writable } from 'node:stream';
import { renderToPipeableStream } from 'react-dom/server';

// Wait for real lazy routes/Suspense to finish. Rendering the loading fallback
// does not test the page, and replacing lazy routes would bypass real routing.
export function renderRouteMarkup(element) {
    return new Promise((resolve, reject) => {
        let html = '';
        const destination = new Writable({ write(chunk, encoding, done) { html += chunk.toString(); done(); } });
        const timeout = setTimeout(() => { stream.abort(); reject(new Error('Route render did not complete within 10 seconds')); }, 10000);
        const fail = error => { clearTimeout(timeout); reject(error); };
        destination.on('error', fail);
        destination.on('finish', () => { clearTimeout(timeout); resolve(html.replaceAll('<!-- -->', '')); });
        const stream = renderToPipeableStream(element, {
            onAllReady() { stream.pipe(destination); },
            onShellError: fail,
            onError: fail,
        });
    });
}

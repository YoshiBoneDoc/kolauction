import { Component } from 'react';
import PropTypes from 'prop-types';

// Keep failures recoverable without automatically reloading or repeating writes.
export default class RenderBoundary extends Component {
    state = { failed: false };
    static getDerivedStateFromError() { return { failed: true }; }
    componentDidCatch(error) { console.error('[kHub] Page rendering failed', error); }
    render() {
        if (!this.state.failed) return this.props.children;
        return <section role="alert" className="mx-auto my-8 max-w-xl rounded-lg border border-gray-300 bg-white p-6 text-gray-900">
            <h1 className="text-xl font-semibold">This page couldn’t be displayed</h1>
            <p className="my-3">A page error or interrupted download prevented it from loading. Reload to try again, or return home.</p>
            <div className="flex flex-wrap gap-4"><button type="button" className="rounded border px-3 py-2" onClick={() => window.location.reload()}>Reload page</button><a className="inline-flex items-center underline" href="/">Return home</a></div>
        </section>;
    }
}
RenderBoundary.propTypes = { children: PropTypes.node.isRequired };

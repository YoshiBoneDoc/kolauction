import {parseDocument, DomUtils} from 'htmlparser2';
import {selectAll} from 'css-select';
import {failureBody} from './operator-logs.mjs';

// Diagnostic observations only: none of these authorize a retry or mark a send successful.
export function mailResponseDiagnostic(html, delivery, httpStatus = null) {
    const doc = parseDocument(String(html ?? ''));
    for (const node of selectAll('script, style, form, blockquote, textarea, input', doc)) DomUtils.removeElement(node);
    let text = DomUtils.textContent(doc).replace(/\s+/g,' ').trim();
    const signals = [];
    for (const [name, pattern] of [
        ['recipient_restricted', /cannot receive Meat or items/i],
        ['legacy_of_loathing_restriction', /Legacy of Loathing players can only receive food, booze, potions, combat and usable items/i],
        ['recipient_ignoring_sender', /(?:ignoring you|has you (?:on|in).{0,30}ignore|ignore list)/i],
        ['mailbox_full', /(?:mailbox|inbox).{0,30}(?:full|too many)/i],
        ['missing_items', /(?:don't|do not|doesn't).{0,30}(?:have|possess).{0,40}(?:item|enough|that many)|not enough.{0,20}items/i],
        ['insufficient_meat', /not enough Meat|don't have.{0,30}Meat/i],
        ['untradeable_item', /(?:cannot|can't).{0,30}(?:trade|send).{0,30}(?:item|quest)|(?:untradeable|untradable)/i],
        ['maintenance', /nightly maintenance|down for maintenance/i],
        ['invalid_authentication', /invalid password hash|invalid pwd/i],
    ]) if(pattern.test(text)) signals.push(name);
    const sensitive = /^(?:account-|verified:)/.test(delivery.dedupe_key || '');
    // The response may echo the submitted outgoing message. Remove it before
    // recording visible server text; suppress free text entirely for account mail.
    for (const body of [delivery.display_message, delivery.message]) {
        if(body) text=text.split(DomUtils.textContent(parseDocument(body)).replace(/\s+/g,' ').trim()).join('[submitted message omitted]');
    }
    return {httpStatus: Number.isInteger(httpStatus)?httpStatus:null, signals,
        serverText: sensitive ? '[account response text omitted]' : failureBody({message:text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}).slice(0,1000)};
}

// A second asset request is permitted ONLY after an explicit ordinary-mail
// refusal. Diagnostic keyword matches and absence of a success message are not
// proof. Inspect standalone result text, never quoted/echoed player messages.
export function confirmedMailRejection(html) {
    const doc = parseDocument(String(html ?? ''));
    for (const node of selectAll('script, style, form, blockquote, textarea, pre, input', doc)) DomUtils.removeElement(node);
    const candidates = [doc, ...selectAll('center, td', doc)].map(node =>
        DomUtils.textContent(node).replace(/\s+/g,' ').trim().replace(/^Results:\s*/i,'').replace(/^Message not sent\s*/i,''));
    const refusals = [
        ['recipient restriction', /^That player cannot receive Meat or items\b/i],
        ['Legacy of Loathing restriction', /^Legacy of Loathing players can only receive food, booze, potions, combat and usable items(?:[.!]|$|\s*Send a Message)/i],
        ['item rejected by ordinary KMail', /^You cannot send this item(?:[.!]|$)/i],
        ['recipient mailbox full', /^(?:That player(?:'s)?|The recipient(?:'s)?) (?:mailbox|inbox) is full(?:[.!]|$)/i],
    ];
    for (const [reason, pattern] of refusals) if(candidates.some(text=>pattern.test(text))) return reason;
    return null;
}

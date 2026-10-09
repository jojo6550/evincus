import { layout, table } from './html.js';

export function alertEmail({ event, subject, rows, reqId, at }) {
  return layout(subject, table([['Event', event], ['When', at.toISOString()], ['Request id', reqId], ...rows]) +
    '<p>Search Workers Logs for the request id to see what happened.</p>');
}

type Fields = Record<string, unknown>;

function emit(level: string, message: string, fields: Fields = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...fields });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message: string, fields?: Fields) => emit('debug', message, fields),
  info: (message: string, fields?: Fields) => emit('info', message, fields),
  warn: (message: string, fields?: Fields) => emit('warn', message, fields),
  error: (message: string, fields?: Fields) => emit('error', message, fields),
};

export function errorFields(err: unknown) {
  return err instanceof Error ? { error: err.message, stack: err.stack } : { error: String(err) };
}

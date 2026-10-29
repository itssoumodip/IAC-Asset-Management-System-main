import 'reflect-metadata';
import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpException,
  INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Request, Response, json } from 'express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { AppModule } from './app.module';
import { configuration, encryptionKey, isAllowedAppOrigin, requestContext } from './config';
import { csrfProtection } from './security';
@Catch()
class ApiExceptionFilter implements ExceptionFilter {
  catch(error: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500,
      message = 'The request could not be completed',
      code = 'INTERNAL_ERROR',
      fields: Record<string, string> | undefined;
    if (error instanceof ZodError) {
      status = 422;
      code = 'VALIDATION_FAILED';
      message = 'Review the submitted fields';
      fields = {};
      for (const item of error.issues) fields[item.path.join('.') || 'form'] = item.message;
    } else if (error instanceof HttpException) {
      status = error.getStatus();
      const response = error.getResponse();
      message =
        typeof response === 'string'
          ? response
          : typeof (response as any).message === 'string'
            ? (response as any).message
            : error.message;
      code =
        (
          {
            400: 'BAD_REQUEST',
            401: 'UNAUTHENTICATED',
            403: 'FORBIDDEN',
            404: 'NOT_FOUND',
            409: 'CONFLICT',
            412: 'VERSION_CONFLICT',
            422: 'VALIDATION_FAILED',
            428: 'VERSION_REQUIRED',
            429: 'RATE_LIMITED',
          } as Record<number, string>
        )[status] || 'REQUEST_FAILED';
      const errors = (response as any)?.fields?.fieldErrors;
      if (errors) {
        fields = {};
        for (const [key, value] of Object.entries(errors))
          if (Array.isArray(value) && value[0]) fields[key] = String(value[0]);
      }
    } else if ((error as any)?.type === 'entity.too.large') {
      status = 413;
      code = 'BODY_TOO_LARGE';
      message =
        (error as any).limit >= 6 * 1024 * 1024
          ? 'Request exceeds the 6 MB JSON upload limit'
          : (error as any).limit > 64 * 1024
            ? 'Request exceeds the 1.5 MB limit'
            : 'Request exceeds the 64 KB limit';
    } else if ((error as any)?.type === 'entity.parse.failed') {
      status = 400;
      code = 'BAD_REQUEST';
      message = 'Request must contain valid JSON';
    } else if ((error as any)?.code === '23505') {
      status = 409;
      code = 'CONFLICT';
      message = 'This record already exists or was changed concurrently';
    } else if (
      ['23503', '23514', '22007', '22P02', '22008', '22003'].includes((error as any)?.code)
    ) {
      status = 422;
      code = 'VALIDATION_FAILED';
      message = 'One or more values are invalid';
    } else if (['55P03', '57014', '40001', '40P01'].includes((error as any)?.code)) {
      status = 409;
      code = 'DATABASE_BUSY';
      message =
        'The operation could not finish because the database is busy. Reload the current record and review it before retrying.';
    } else if (['42P01', '42703', '42883'].includes((error as any)?.code)) {
      status = 503;
      code = 'DATABASE_SCHEMA_OUT_OF_DATE';
      message =
        'The server database is missing an update. Deploy the latest version and apply database migrations.';
    }
    if (status >= 500) {
      const errorCode = (error as any)?.code;
      const errorName = error instanceof Error ? error.name : 'UnknownError';
      process.stderr.write(
        `Request failed (${res.getHeader('X-Request-Id') || 'unknown'}) [${errorName}${errorCode ? ` ${String(errorCode).slice(0, 32)}` : ''}]\n`,
      );
    }
    res.status(status).json({
      error: {
        code,
        message,
        requestId: res.getHeader('X-Request-Id'),
        ...(fields ? { fields } : {}),
      },
    });
  }
}
export async function createApp(): Promise<INestApplication> {
  configuration();
  for (const key of ['TOTP_ENCRYPTION_KEY', 'AUTH_MAIL_ENCRYPTION_KEY', 'CSRF_SECRET'])
    encryptionKey(key);
  const app = await NestFactory.create(AppModule, { bodyParser: false, logger: ['error', 'warn'] });
  const server = app.getHttpAdapter().getInstance();
  server.disable('x-powered-by');
  server.set('trust proxy', Number(process.env.TRUST_PROXY_HOPS || 0));
  app.use((req: Request, res: Response, next: () => void) => {
    res.setHeader('X-Request-Id', randomUUID());
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    requestContext.run({ id: String(res.getHeader('X-Request-Id')) }, next);
  });
  app.use(helmet());
  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) return callback(null, false);
      callback(null, isAllowedAppOrigin(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'If-Match', 'Idempotency-Key'],
    exposedHeaders: ['ETag', 'X-Request-Id'],
  });
  app.use('/api/v1/tickets', (req: Request, res: Response, next: () => void) =>
    req.method === 'POST' &&
    req.path === '/' &&
    isAllowedAppOrigin(req.headers.origin || '') &&
    (req.headers.cookie || '')
      .split(';')
      .some((c) => c.trim().startsWith(`${configuration().sessionCookie}=`))
      ? json({ limit: '1536kb' })(req, res, next)
      : next(),
  );
  app.use('/api/v1/finance/assets', (req: Request, res: Response, next: () => void) =>
    req.method === 'POST' &&
    /^\/[^/]+\/invoices$/.test(req.path) &&
    isAllowedAppOrigin(req.headers.origin || '') &&
    (req.headers.cookie || '')
      .split(';')
      .some((c) => c.trim().startsWith(`${configuration().sessionCookie}=`))
      ? json({ limit: '6mb' })(req, res, next)
      : next(),
  );
  app.use('/api/v1/transfers', (req: Request, res: Response, next: () => void) =>
    req.method === 'POST' &&
    req.path === '/preview' &&
    isAllowedAppOrigin(req.headers.origin || '') &&
    (req.headers.cookie || '')
      .split(';')
      .some((c) => c.trim().startsWith(`${configuration().sessionCookie}=`))
      ? json({ limit: '6mb' })(req, res, next)
      : next(),
  );
  app.use('/api/v1/push', (req: Request, res: Response, next: () => void) =>
    req.method === 'POST' &&
    req.path === '/broadcast' &&
    isAllowedAppOrigin(req.headers.origin || '') &&
    (req.headers.cookie || '')
      .split(';')
      .some((c) => c.trim().startsWith(`${configuration().sessionCookie}=`))
      ? json({ limit: '6mb' })(req, res, next)
      : next(),
  );
  app.use(json({ limit: '64kb' }));
  app.use(cookieParser());
  app.use(csrfProtection);
  app.setGlobalPrefix('api/v1');
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();
  await app.init();
  return app;
}
if (require.main === module) {
  void createApp()
    .then((app) => app.listen(configuration().port, '0.0.0.0'))
    .catch(() => {
      process.stderr.write(
        'API startup failed. Check environment configuration and database connectivity.\n',
      );
      process.exitCode = 1;
    });
}

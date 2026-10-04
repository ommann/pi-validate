import { APP_BASE_HREF, LocationStrategy, TrailingSlashPathLocationStrategy } from '@angular/common';
import { provideHttpClient } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from '@app/app.routes';

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideHttpClient(),
    provideRouter(routes, withComponentInputBinding()),
    { provide: APP_BASE_HREF, useValue: '/' },
    { provide: LocationStrategy, useClass: TrailingSlashPathLocationStrategy },
  ],
};

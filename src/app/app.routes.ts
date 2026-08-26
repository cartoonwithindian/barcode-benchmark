import { Routes } from '@angular/router';
import { ScannerPage } from './pages/scanner-page/scanner-page';
import { ImageBenchmarkPage } from './pages/image-benchmark-page/image-benchmark-page';
import { DashboardPage } from './pages/dashboard-page/dashboard-page';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'scanner' },
  { path: 'scanner', component: ScannerPage },
  { path: 'images', component: ImageBenchmarkPage },
  { path: 'dashboard', component: DashboardPage },
];

import { trait } from 'koota';
import type { ColorGradeSettings } from '@diffusionstudio/jsx';

export const ColorGrade = trait({ value: () => ({} as ColorGradeSettings) });

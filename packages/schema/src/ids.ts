import { z } from 'zod';

export const FirmId = z.string().regex(/^firm_[a-z0-9]{6,32}$/);
export const EmployeeId = z.string().regex(/^emp_[a-z0-9]{6,32}$/);
export const DeviceId = z.string().regex(/^dev_[a-z0-9]{6,32}$/);
export const ConversationId = z.string().min(1).max(512);
export const MessageId = z.string().min(1).max(256);

export type FirmId = z.infer<typeof FirmId>;
export type EmployeeId = z.infer<typeof EmployeeId>;
export type DeviceId = z.infer<typeof DeviceId>;

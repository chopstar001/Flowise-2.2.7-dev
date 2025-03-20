// utils/idManagement.ts

import { v4 as uuidv4 } from 'uuid';

export type IdType = 'session' | 'user' | 'chat';

interface IdPrefix {
  readonly SESSION: string;
  readonly USER: string;
  readonly CHAT: string;
  [key: string]: string; // Index signature for string access
}

export class IDManager {
  private static readonly ID_PREFIX: IdPrefix = {
    SESSION: 'ses',
    USER: 'usr',
    CHAT: 'cht'
  } as const;

  static formatId(id: string | number, type: IdType): string {
    // If it's already our format, return as is
    if (this.isFormattedId(id)) {
      return id.toString();
    }

    const prefix = this.ID_PREFIX[type.toUpperCase() as keyof IdPrefix];
    const normalizedId = this.normalizeId(id);
    
    return `${prefix}_${normalizedId}`;
  }

  static parseId(formattedId: string): {
    type: IdType;
    value: string;
  } {
    const [prefix, value] = formattedId.split('_');
    const type = Object.entries(this.ID_PREFIX)
      .find(([_, p]) => p === prefix)?.[0].toLowerCase() as IdType;
    
    return { type, value };
  }

  private static normalizeId(id: string | number): string {
    if (typeof id === 'number') {
      return id.toString();
    }
    // Remove any non-alphanumeric characters except hyphens
    return id.replace(/[^a-zA-Z0-9-]/g, '');
  }

  private static isFormattedId(id: string | number): boolean {
    const strId = id.toString();
    return Object.values(this.ID_PREFIX).some(prefix => 
      strId.startsWith(`${prefix}_`)
    );
  }

  static generateNewId(type: IdType): string {
    return this.formatId(uuidv4(), type);
  }
}
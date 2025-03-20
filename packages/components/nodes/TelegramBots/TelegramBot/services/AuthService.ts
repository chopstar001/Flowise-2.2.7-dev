//services/AuthService.ts

import { DatabaseService } from './DatabaseService';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { logInfo, logError } from '../loggingUtility';
import {
  UserAccount,
  UserStats,
  TokenUsage,
  AuthRequest,
  TelegramAuthData,
  WebAuthResponse,
  AuthTokens,
  WebAuthData,
  WalletAuthData
} from '../commands/types';
import {
  AUTH_TYPES,
  SUBSCRIPTION_TIERS,
  type AuthType,
  type SubscriptionTier,
  type CreateUserDTO,
  SessionCreationDTO,
  type UserData
} from '../services/DatabaseService';
import { Telegram } from 'telegraf';





/**
 * The AuthService class provides authentication-related functionality for the application.
 * It handles authentication using various methods such as Telegram, wallet, and email.
 * The class is responsible for generating and managing access and refresh tokens, as well as
 * validating and refreshing tokens. It also provides functionality for handling web authentication
 * and creating user sessions.
 */
export class AuthService {
  private databaseService: DatabaseService;
  private readonly JWT_SECRET: string;
  private readonly ACCESS_TOKEN_EXPIRY = '1h';
  private readonly REFRESH_TOKEN_EXPIRY = '7d';
  private readonly DEFAULT_TOKEN_QUOTA = 10000; // Default monthly token quota for free tier

  constructor(databaseService: DatabaseService) {
    this.databaseService = databaseService;
    this.JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
  }

  async authenticateTelegram(telegramUser: { id: number; username?: string; }): Promise<AuthTokens> {
    const userId = await this.databaseService.normalizeUserId(
      telegramUser.id.toString(),
      AUTH_TYPES.TELEGRAM
    );
    return this.generateTokens(userId);
  }

  /**
   * Verifies the provided token and returns the associated user ID if the token is valid.
   *
   * @param token - The token to be verified.
   * @returns An object containing the user ID associated with the verified token.
   * @throws Error if the token is invalid or has been revoked.
   */
  async verifyToken(token: string): Promise<{ userId: string }> {
    try {
      const decoded = jwt.verify(token, this.JWT_SECRET) as { userId: string; type: string };
      const isValid = await this.databaseService.validateAuthToken(token);

      if (!isValid) {
        throw new Error('Token has been revoked');
      }

      return { userId: decoded.userId };
    } catch (error) {
      throw new Error('Invalid token');
    }
  }

  /**
   * Generates a new access token and refresh token for the specified user ID.
   *
   * @param userId - The user ID to generate tokens for.
   * @returns An object containing the new access token and refresh token.
   */
  private async generateTokens(userId: string): Promise<AuthTokens> {
    const timestamp = Date.now();

    const accessToken = jwt.sign(
      { userId, type: 'access', timestamp },
      this.JWT_SECRET,
      { expiresIn: this.ACCESS_TOKEN_EXPIRY }
    );

    const refreshToken = jwt.sign(
      { userId, type: 'refresh', timestamp },
      this.JWT_SECRET,
      { expiresIn: this.REFRESH_TOKEN_EXPIRY }
    );

    await this.databaseService.storeAuthTokens(userId, accessToken, refreshToken);
    return { accessToken, refreshToken };
  }

  /**
   * Generates a temporary authentication token for the specified user ID.
   *
   * The generated token is valid for 30 minutes and is stored in the database.
   *
   * @param userId - The user ID to generate the temporary authentication token for.
   * @returns The generated temporary authentication token.
   */
  public async generateTempAuthToken(userId: string): Promise<string> {
    const methodName = 'generateTempAuthToken';

    // Get current time and add 30 minutes
    const now = new Date();
    const expiryTime = new Date(now.getTime() + 30 * 60 * 1000);

    logInfo(methodName, 'Generating token:', {
      userId,
      currentAEST: now.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' }),
      expiryAEST: expiryTime.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
    });

    const token = jwt.sign(
      {
        userId,
        type: 'temp_auth',
        timestamp: now.getTime(),
        expires: expiryTime.getTime()
      },
      this.JWT_SECRET,
      { expiresIn: '30m' }
    );

    await this.databaseService.storeTempAuthToken(userId, token, expiryTime);
    return token;
  }



  async authenticateWallet(address: string): Promise<AuthTokens> {
    const userId = `wallet_${address.toLowerCase()}`;
    const userData = {
      id: userId,
      type: 'wallet' as const,
      wallet_address: address.toLowerCase(),
      subscription_tier: 'free' as const,
      token_quota: this.DEFAULT_TOKEN_QUOTA
    };

    await this.databaseService.getOrCreateUser(userData);
    return this.generateTokens(userId);
  }

  async authenticateEmail(email: string, password: string): Promise<AuthTokens> {
    const user = await this.databaseService.getUserByEmail(email);
    if (!user || !user.password_hash) {
      throw new Error('User not found');
    }

    const isValid = await bcrypt.compare(password, user.password_hash);
    if (!isValid) {
      throw new Error('Invalid password');
    }

    return this.generateTokens(user.id);
  }

  async registerEmailUser(email: string, password: string): Promise<AuthTokens> {
    const userId = `email_${uuidv4()}`;
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);

    const userData = {
      id: userId,
      type: 'email' as const,
      email,
      password_hash: hashedPassword,
      subscription_tier: 'free' as const,
      token_quota: this.DEFAULT_TOKEN_QUOTA
    };

    await this.databaseService.getOrCreateUser(userData);
    return this.generateTokens(userId);
  }

  public async refreshAuthToken(userId: string): Promise<boolean> {
    const methodName = 'refreshAuthToken';
    try {
      await this.databaseService.updateAuthTokenExpiry(userId);

      const currentTime = new Date();
      logInfo(methodName, 'Auth token refreshed:', {
        userId,
        currentAEST: currentTime.toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })
      });

      return true;
    } catch (error) {
      logError(methodName, 'Error refreshing auth token:', error as Error);
      return false;
    }
  }
}
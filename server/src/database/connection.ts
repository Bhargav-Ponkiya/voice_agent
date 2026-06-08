import mongoose from 'mongoose';
import { config } from '../config';
import { logger } from '../utils/logger';

export async function connectDatabase(): Promise<void> {
  // Register event listeners before connecting so we never miss them
  mongoose.connection.on('disconnected', () => {
    logger.warn('MongoDB disconnected — Mongoose will auto-reconnect');
  });

  mongoose.connection.on('reconnected', () => {
    logger.info('MongoDB reconnected');
  });

  mongoose.connection.on('error', (err) => {
    logger.error('MongoDB connection error', err);
  });

  const maxRetries = 5;
  let retryCount = 0;

  while (retryCount < maxRetries) {
    try {
      await mongoose.connect(config.mongodb.uri, {
        // Automatically retry failed operations up to 3 times
        serverSelectionTimeoutMS: 10_000,
        socketTimeoutMS: 45_000,
        maxPoolSize: 10,   // Cap concurrent DB connections
        minPoolSize: 2,    // Keep a warm minimum pool
      });
      logger.info('MongoDB connected');
      return;
    } catch (err) {
      retryCount++;
      logger.error(`MongoDB connection attempt ${retryCount}/${maxRetries} failed:`, err);
      if (retryCount >= maxRetries) {
        logger.error('MongoDB initial connection failed permanently after max retries');
        process.exit(1);
      }
      logger.info('Retrying MongoDB connection in 5 seconds...');
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

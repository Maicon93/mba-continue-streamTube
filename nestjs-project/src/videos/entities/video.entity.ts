import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Channel } from '../../channels/entities/channel.entity';

export enum VideoStatus {
  Draft = 'draft',
  Processing = 'processing',
  Ready = 'ready',
  Failed = 'failed',
}

/** Metadata kept for diagnostics; the fields the product reads are columns. */
export interface VideoProbeMetadata {
  codec_name: string | null;
  bit_rate: string | null;
  avg_frame_rate: string | null;
  format_name: string | null;
}

@Entity('videos')
export class Video {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 12, unique: true })
  public_id: string;

  @Index()
  @Column({ type: 'uuid' })
  channel_id: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Index()
  @Column({
    type: 'enum',
    enum: VideoStatus,
    default: VideoStatus.Draft,
  })
  status: VideoStatus;

  @Column({ type: 'varchar', length: 100 })
  content_type: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  source_key: string | null;

  @Column({ type: 'varchar', length: 512, nullable: true })
  thumbnail_key: string | null;

  /** Open multipart upload; cleared once the upload is completed. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  upload_id: string | null;

  @Column({ type: 'int', nullable: true })
  duration_seconds: number | null;

  @Column({ type: 'int', nullable: true })
  width: number | null;

  @Column({ type: 'bigint', nullable: true })
  size_bytes: string | null;

  @Column({ type: 'int', nullable: true })
  height: number | null;

  @Column({ type: 'jsonb', nullable: true })
  metadata: VideoProbeMetadata | null;

  @Column({ type: 'text', nullable: true })
  failure_reason: string | null;

  @CreateDateColumn()
  created_at: Date;

  @UpdateDateColumn()
  updated_at: Date;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'channel_id' })
  channel: Channel;
}

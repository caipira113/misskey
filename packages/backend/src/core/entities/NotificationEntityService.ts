/*
 * SPDX-FileCopyrightText: syuilo and other misskey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { In } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { FollowRequestsRepository, NotesRepository, MiUser, UsersRepository } from '@/models/_.js';
import { awaitAll } from '@/misc/prelude/await-all.js';
import type { MiNotification } from '@/models/Notification.js';
import type { MiNote } from '@/models/Note.js';
import type { Packed } from '@/misc/json-schema.js';
import { bindThis } from '@/decorators.js';
import { isNotNull } from '@/misc/is-not-null.js';
import { notificationTypes } from '@/types.js';
import type { OnModuleInit } from '@nestjs/common';
import type { CustomEmojiService } from '../CustomEmojiService.js';
import type { UserEntityService } from './UserEntityService.js';
import type { NoteEntityService } from './NoteEntityService.js';

const NOTE_REQUIRED_NOTIFICATION_TYPES = new Set(['note', 'mention', 'reply', 'renote', 'quote', 'reaction', 'pollEnded'] as (typeof notificationTypes[number])[]);

@Injectable()
export class NotificationEntityService implements OnModuleInit {
	private userEntityService: UserEntityService;
	private noteEntityService: NoteEntityService;
	private customEmojiService: CustomEmojiService;

	constructor(
		private moduleRef: ModuleRef,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.followRequestsRepository)
		private followRequestsRepository: FollowRequestsRepository,

		//private userEntityService: UserEntityService,
		//private noteEntityService: NoteEntityService,
		//private customEmojiService: CustomEmojiService,
	) {
	}

	onModuleInit() {
		this.userEntityService = this.moduleRef.get('UserEntityService');
		this.noteEntityService = this.moduleRef.get('NoteEntityService');
		this.customEmojiService = this.moduleRef.get('CustomEmojiService');
	}

	@bindThis
	public async pack(
		src: MiNotification,
		meId: MiUser['id'],
		// eslint-disable-next-line @typescript-eslint/ban-types
		options: {

		},
		hint?: {
			packedNotes: Map<MiNote['id'], Packed<'Note'>>;
			packedUsers: Map<MiUser['id'], Packed<'User'>>;
		},
	): Promise<Packed<'Notification'>> {
		const notification = src;
		const noteIfNeed = NOTE_REQUIRED_NOTIFICATION_TYPES.has(notification.type) && notification.noteId != null ? (
			hint?.packedNotes != null
				? hint.packedNotes.get(notification.noteId)
				: this.noteEntityService.pack(notification.noteId!, { id: meId }, {
					detail: true,
				})
		) : undefined;
		const userIfNeed = notification.notifierId != null ? (
			hint?.packedUsers != null
				? hint.packedUsers.get(notification.notifierId)
				: this.userEntityService.pack(notification.notifierId!, { id: meId }, {
					detail: false,
				})
		) : undefined;

		return await awaitAll({
			id: notification.id,
			createdAt: new Date(notification.createdAt).toISOString(),
			type: notification.type,
			userId: notification.notifierId,
			...(userIfNeed != null ? { user: userIfNeed } : {}),
			...(noteIfNeed != null ? { note: noteIfNeed } : {}),
			...(notification.type === 'reaction' ? {
				reaction: notification.reaction,
			} : {}),
			...(notification.type === 'achievementEarned' ? {
				achievement: notification.achievement,
			} : {}),
			...(notification.type === 'app' ? {
				body: notification.customBody,
				header: notification.customHeader,
				icon: notification.customIcon,
			} : {}),
		});
	}

	@bindThis
	public async packMany(
		notifications: MiNotification[],
		meId: MiUser['id'],
	) {
		if (notifications.length === 0) return [];

		let validNotifications = notifications;

		const noteIds = validNotifications.map(x => x.noteId).filter(isNotNull);
		const notes = noteIds.length > 0 ? await this.notesRepository.find({
			where: { id: In(noteIds) },
			relations: ['user', 'reply', 'reply.user', 'renote', 'renote.user'],
		}) : [];
		const packedNotesArray = await this.noteEntityService.packMany(notes, { id: meId }, {
			detail: true,
		});
		const packedNotes = new Map(packedNotesArray.map(p => [p.id, p]));

		validNotifications = validNotifications.filter(x => x.noteId == null || packedNotes.has(x.noteId));

		const userIds = validNotifications.map(x => x.notifierId).filter(isNotNull);
		const users = userIds.length > 0 ? await this.usersRepository.find({
			where: { id: In(userIds) },
		}) : [];
		const packedUsersArray = await this.userEntityService.packMany(users, { id: meId }, {
			detail: false,
		});
		const packedUsers = new Map(packedUsersArray.map(p => [p.id, p]));

		// 既に解決されたフォローリクエストの通知を除外
		const followRequestNotifications = validNotifications.filter(x => x.type === 'receiveFollowRequest');
		if (followRequestNotifications.length > 0) {
			const reqs = await this.followRequestsRepository.find({
				where: { followerId: In(followRequestNotifications.map(x => x.notifierId!)) },
			});
			validNotifications = validNotifications.filter(x => (x.type !== 'receiveFollowRequest') || reqs.some(r => r.followerId === x.notifierId));
		}

		return await Promise.all(validNotifications.map(x => this.pack(x, meId, {}, {
			packedNotes,
			packedUsers,
		})));
	}
}

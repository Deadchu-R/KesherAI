"""Lays out tonight's rows with room beside each board, and puts a sticky next to every changed board.
The newest change is orange "השינוי הכי חדש"; earlier ones gray "עודכן". Run after adding to design_marks.json."""
import json
import os
S=os.environ.get('DESIGN_DIR') or os.path.expanduser('~/design-work')
P=S+'/design2/project'
c=json.load(open(P+'/canvas.json'))
B=c['boards']
rows=[
 (24100, ['StudySummary.dc.html','StudyTools.dc.html','StudyOpenQuiz.dc.html','StudySearchNotes.dc.html']),
 (25200, ['PhoneStudySummary.dc.html','PhoneStudyTools.dc.html','PhoneStudyOpenQuiz.dc.html','RemotePcDrop.dc.html','PhoneStudyRecordOff.dc.html','PhoneStudyRecordText.dc.html']),
 (26300, ['AppCall.dc.html','AppCallSpeaking.dc.html','AppCallCamera.dc.html']),
 (27500, ['UpdatedCard.dc.html','PhoneUpdatedCard.dc.html']),
 (28150, ['SettingsGpuSplit.dc.html','AppWidget.dc.html','ModelsMove.dc.html','ComputerTabs.dc.html']),
 (29000, ['StudyCourseModel.dc.html','StudyRecordingKeep.dc.html','PhoneStudyRecordingKeep.dc.html']),
 (29900, ['ChatQuestions.dc.html','PhoneChatQuestions.dc.html']),
 (30900, ['GodotPage.dc.html','PhoneDrawerComputers.dc.html','GuardSuggest.dc.html']),
 (32200, ['ApiKeysEngines.dc.html']),
 (32900, ['StremioPage.dc.html']),
 (33900, ['VoiceClone.dc.html']),
 (34700, ['DepthFrameFlow.dc.html']),
 (35500, ['McpKnowledgeTags.dc.html']),
 (36300, ['HeavyFolder.dc.html']),
 (37100, ['SongLyricsCount.dc.html']),
 (37700, ['SshProject.dc.html']),
 (38600, ['ChatReport.dc.html','ChatReportImport.dc.html']),
 (40100, ['ChatReportWizard.dc.html']),
 (41000, ['ChatReportStory1.dc.html','ChatReportDesktop1.dc.html']),
 (41880, ['ChatReportStory2.dc.html','ChatReportDesktop2.dc.html']),
 (42820, ['ChatReportStory3.dc.html']),
 (43760, ['ChatReportStory4.dc.html']),
 (44700, ['UnrealOfflineSync.dc.html']),
 (45700, ['RichChatDesktop.dc.html','RichChatPhone.dc.html','PlusMenu.dc.html']),
 (47100, ['ArtifactPanel.dc.html']),
 (48400, ['DesignCanvasChat.dc.html']),
 (49700, ['ModelTeam.dc.html']),
 (50600, ['PlusMenu.dc.html','PlusMenuDesktop.dc.html']),
 (51600, ['MoodleStudy.dc.html','MoodlePhone.dc.html']),
 (52500, ['DeadlinePlan.dc.html','DeadlinePlanPhone.dc.html']),
 (53400, ['VideoOverview.dc.html','VideoOverviewPhone.dc.html']),
 (54200, ['RunReview.dc.html']),
 (55000, ['TeachBack.dc.html']),
 (55900, ['VideoLecture.dc.html','VideoLecturePhone.dc.html']),
 (56800, ['TopicMastery.dc.html','TopicMasteryPhone.dc.html']),
 (57400, ['FunctionGraph.dc.html','FunctionGraphPhone.dc.html']),
 (58200, ['SaveToCourse.dc.html','SaveToCoursePhone.dc.html']),
 (59000, ['IdeaSession.dc.html','IdeaSessionPhone.dc.html']),
 (59900, ['StudyMatch.dc.html','StudyMatchPhone.dc.html']),
 (60700, ['DailyGoal.dc.html','DailyGoalPhone.dc.html']),
 (61500, ['StudyWelcome.dc.html','StudyWelcomePhone.dc.html']),
 (62200, ['StudySimple.dc.html']),
 (62700, ['FocusComfort.dc.html','FocusComfortPhone.dc.html']),
 (63300, ['MyMistakes.dc.html','MyMistakesPhone.dc.html']),
 (64000, ['CoursePath.dc.html','CoursePathPhone.dc.html']),
 (64700, ['StudyWeekQuick.dc.html','StudyWeekQuickPhone.dc.html']),
 (65200, ['OralExam.dc.html','OralExamPhone.dc.html']),
 (65800, ['StudyViewSettings.dc.html']),
 (66200, ['LectureSlides.dc.html','LectureSlidesPhone.dc.html']),
 (66800, ['WritingCoach.dc.html','WritingCoachPhone.dc.html']),
 (67600, ['CompareMindmap.dc.html','CompareMindmapPhone.dc.html']),
 (68400, ['DeckEditor.dc.html','DeckEditorPhone.dc.html']),
 (69400, ['DocEditor.dc.html','DocEditorPhone.dc.html']),
 (70300, ['MockExam.dc.html','MockExamPhone.dc.html']),
 (71000, ['Grades.dc.html','GradesPhone.dc.html']),
 (71700, ['Timetable.dc.html','TimetablePhone.dc.html']),
 (72400, ['ReadHighlights.dc.html','ReadHighlightsPhone.dc.html']),
 (73200, ['LectureSheet.dc.html','LiveAsk.dc.html']),
 (74000, ['SheetEditor.dc.html','SheetEditorPhone.dc.html']),
 (74800, ['ScreenLens.dc.html','ScreenLensPhone.dc.html']),
 (75600, ['StremioAnime.dc.html','StremioAnimePhone.dc.html']),
 (76300, ['ListenSpeed.dc.html','ListenSpeedPhone.dc.html']),
 (76900, ['SlidesSync.dc.html']),
 (77500, ['ImageOcclusion.dc.html','ImageOcclusionPhone.dc.html']),
 (78100, ['LiveQuiz.dc.html','LiveQuizPhone.dc.html']),
 (78700, ['TimeNotes.dc.html','TimeNotesPhone.dc.html']),
 (79400, ['StudyTogether.dc.html','StudyTogetherPhone.dc.html']),
 (80300, ['Papers.dc.html','PapersPhone.dc.html']),
 (81300, ['DegreeProgress.dc.html','DegreeProgressPhone.dc.html']),
 (82100, ['SimilarAndWhere.dc.html','SimilarAndWherePhone.dc.html']),
 (82900, ['ProblemPhoto.dc.html','ProblemPhotoPhone.dc.html']),
 (83500, ['QuizTalkPalace.dc.html','QuizTalkPalacePhone.dc.html']),
 (84200, ['Podcast.dc.html','PodcastPhone.dc.html']),
 (84700, ['TopicVideos.dc.html','TopicVideosPhone.dc.html']),
 (85300, ['HardCards.dc.html','HardCardsPhone.dc.html']),
 (86000, ['Portions.dc.html','PortionsPhone.dc.html']),
 (86700, ['IsraeliStudent.dc.html','IsraeliStudentPhone.dc.html']),
 (87700, ['ExamEveRehearse.dc.html','ExamEveRehearsePhone.dc.html']),
 (88400, ['Part33.dc.html','Part33Phone.dc.html']),
 (89500, ['StudyFeed.dc.html','StudyFeedPhone.dc.html']),
 (90200, ['PhoneAlone.dc.html','PhoneAlonePhone.dc.html']),
 (91000, ['PhoneShareLens.dc.html']),
 (91700, ['StudyWelcomePhoto.dc.html','StudyWelcomePhotoPhone.dc.html']),
 (92300, ['PhoneMock.dc.html']),
 (93100, ['PhoneTeachBack.dc.html','PhoneWritingCoach.dc.html','PhoneWeek.dc.html','PhoneHighlights.dc.html']),
 (93900, ['PhoneMistakes.dc.html','PhoneMatch.dc.html']),
 (94700, ['StudySetupWizard.dc.html']),
 (95500, ['StudySetupChecklist.dc.html','StudySetupWizardPhone.dc.html']),
 (96400, ['PhoneOcclusion.dc.html']),
 (97200, ['BackOnTrack.dc.html','BackOnTrackPhone.dc.html']),
 (98100, ['QuestionCheck.dc.html','QuestionCheckPhone.dc.html']),
 (98900, ['PhoneAskVoice.dc.html']),
 (99600, ['Attendance.dc.html','AttendancePhone.dc.html']),
 (100300, ['PhoneRehearseRuns.dc.html']),
 (101000, ['ImportSteps.dc.html','ChatPick.dc.html']),
 (101700, ['StudySetupAddress.dc.html']),
 (102400, ['ModelSuggest.dc.html','ModelSuggestPhone.dc.html']),
 (103300, ['StremioHistory.dc.html','StremioHistoryPhone.dc.html']),
 (104300, ['AppIcon.dc.html']),
 (105500, ['SlashBuiltins.dc.html']),
 (106200, ['PromptFields.dc.html']),
 (106900, ['FilePreviewWorkspace.dc.html']),
 (107800, ['ModelLoadSettings.dc.html','ModelLoadSettingsPhone.dc.html']),
 (108800, ['TabsImageEditor.dc.html','TabsImageEditorPhone.dc.html']),
 (109800, ['ImageEditorAITools.dc.html']),
 (110800, ['VideoEditorAITools.dc.html','SoundEditorAITools.dc.html','Model3DEditorAITools.dc.html']),
 (111800, ['ProjectShare.dc.html','ProjectGuestPhone.dc.html']),
 (112800, ['ImageEditorWorkspace.dc.html','ImageEditorWorkspacePhone.dc.html']),
 (113800, ['ChatReportChapters.dc.html','ChatReportChaptersPhone.dc.html']),
 (114900, ['TabsPhoneBar.dc.html','TabsPhoneSwitcher.dc.html']),
 (116000, ['VideoEditorWorkspace.dc.html','VideoEditorWorkspacePhone.dc.html','SoundEditorWorkspace.dc.html','Model3DEditorWorkspace.dc.html']),
 (117100, ['HumToInstrument.dc.html']),
 (118100, ['TextureHandoff.dc.html']),
 (119100, ['SceneStandIn.dc.html','SceneStandIn2D.dc.html','SceneStandInPhone.dc.html']),
 (97800, ['PhoneProgress.dc.html']),
 (167700, ['GamesProjects.dc.html','GamesProjectsPhone.dc.html']),
 (169100, ['GamesSyncSheet.dc.html','GamesSyncSheetPhone.dc.html']),
 (170500, ['HubNotify.dc.html','HubNotifyPhone.dc.html','HubNotifyAppPhone.dc.html']),
 (171700, ['GamesSearch.dc.html','GamesSearchPhone.dc.html']),
 (173100, ['GamesSource.dc.html','GamesSourcePhone.dc.html']),
]
SIDE=300
for y,names in rows:
    x=0
    for n in names:
        B[n]['x']=x; B[n]['y']=y
        x+=B[n]['w']+40+260+80
marks=json.load(open(S+'/design_marks.json'))
for k in [k for k in c['notes'] if k.startswith('mk-')]:
    del c['notes'][k]
c['noteOrder']=[k for k in c['noteOrder'] if not k.startswith('mk-')]
newest=marks[-1][1]
# Only the newest change gets a marker (asked 2026-11-16 22:46): it moves to each new change. A change that adds
# several boards in one go (same stamp) marks each of them.
marks=[m for m in marks if m[1]==newest]
# The newest page glows orange behind it (asked 2026-11-16 22:59): no zoom, no sticky; only the newest one.
G='NewestGlow.dc.html'
c['launch']={'view':'canvas'}
c.setdefault('order',[])
for i,(n,_,t) in enumerate(marks):
    b=B[n]; pad=28
    # No glow behind the newest page any more (asked 2026-11-17 12:58: it hid screens); only the note above it.
    B.pop(G, None)
    # The glow board only draws when zoomed in; a wide orange note above it shows at every zoom (asked 23:03).
    c['notes'][f'mk-newest{i}']={'x':b['x']-pad,'y':b['y']-pad-340,'w':b['w']+2*pad,'text':f'🆕 הכי חדש · {t}','fill':'orange','size':'xl','bold':True}
    c['noteOrder'].append(f'mk-newest{i}')
    c['order']=[o for o in c['order'] if o != G]
    if n not in c['order']: c['order'].append(n)
json.dump(c,open(P+'/canvas.json','w'),ensure_ascii=False,indent=1)
print('newest notes above',[m[0] for m in marks])

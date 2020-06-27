import { Component, OnInit, Input, Output, EventEmitter, OnDestroy } from '@angular/core';
import { FormGroup, FormControl, Validators } from '@angular/forms';
import { SubscriptionLike } from 'rxjs';
import { debounceTime } from 'rxjs/internal/operators/debounceTime';

@Component({
  selector: 'new-search-box',
  templateUrl: './new-search-box.component.html',
  styleUrls: ['./new-search-box.component.scss']
})
export class NewSearchBoxComponent implements OnInit, OnDestroy {

  @Input() debounceTime = 300;
  @Input() showButton = true;
  @Input() placeholder = 'enter search term...';
  @Input() buttonLabel = 'search';

  @Output() searchChanged = new EventEmitter<string>();
  @Output() searchSubmitted = new EventEmitter<string>();

  form: FormGroup;
  private searchSubscription: SubscriptionLike;

  constructor() {
    this.form = new FormGroup({
      search: new FormControl('', Validators.required)
    });

    this.searchSubscription = this.form.controls.search.valueChanges.pipe(
      debounceTime(this.debounceTime)
    ).subscribe(v => this.searchChanged.emit(v));
  }

  ngOnInit() {
  }

  ngOnDestroy(): void {
    this.searchSubscription.unsubscribe();
  }

  onSubmit(data: any) {
    console.log(data.search);
    this.searchSubmitted.emit(data.search);
  }
}
